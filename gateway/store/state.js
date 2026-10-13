// Onyx Gateway: settings, the audit trail, the directory snapshot and the request log.

export class State {
  /** @param {import("better-sqlite3").Database} db */
  constructor(db, { now = Date.now } = {}) {
    this.db = db;
    this.now = now;
    this._directory = null;
  }

  // ─── Settings ───────────────────────────────────────────
  get(key, fallback = null) {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    return row ? JSON.parse(row.value) : fallback;
  }

  set(key, value) {
    this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
  }

  get enabled() {
    return this.get("enabled", false) === true;
  }

  get personalKeys() {
    return this.get("personal_keys", true) === true;
  }

  // ─── Audit ──────────────────────────────────────────────
  audit = (actor, action, target, detail) => {
    this.db.prepare("INSERT INTO audit (ts, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)").run(this.now(), String(actor || "sparkDash"), action, target ?? null, detail ?? null);
  };

  eventsSince(id, limit = 200) {
    return this.db.prepare("SELECT * FROM audit WHERE id > ? ORDER BY id LIMIT ?").all(Number(id) || 0, Math.min(limit, 1000));
  }

  // ─── Directory (pushed by the Observer) ─────────────────
  setDirectory(snapshot) {
    const clean = {
      people: (snapshot?.people || []).map((p) => ({ login: String(p.login), name: p.name ?? p.displayName ?? null, role: p.role })),
      groups: (snapshot?.groups || []).map((g) => ({ name: String(g.name), members: (g.members || []).map(String) })),
    };
    this.db
      .prepare("INSERT INTO directory (id, snapshot, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET snapshot = excluded.snapshot, updated_at = excluded.updated_at")
      .run(JSON.stringify(clean), this.now());
    this._directory = clean;
  }

  directory() {
    if (!this._directory) {
      const row = this.db.prepare("SELECT snapshot FROM directory WHERE id = 1").get();
      this._directory = row ? JSON.parse(row.snapshot) : { people: [], groups: [] };
    }
    return this._directory;
  }

  person(login) {
    return this.directory().people.find((p) => p.login.toLowerCase() === String(login).toLowerCase()) || null;
  }

  // ─── Requests ───────────────────────────────────────────
  recordRequest(r) {
    return this.db
      .prepare(
        `INSERT INTO requests (ts, identity, via, device, client, provider_id, model, format, stream, status, latency_ms, ttfb_ms, cost_basis, partial, session_id, agent_id, error)
         VALUES (@ts, @identity, @via, @device, @client, @providerId, @model, @format, @stream, @status, @latencyMs, @ttfbMs, @costBasis, @partial, @sessionId, @agentId, @error)`
      )
      .run({
        ts: r.ts,
        identity: r.identity,
        via: r.via,
        device: r.device ?? null,
        client: r.client ?? null,
        providerId: r.providerId ?? null,
        model: r.model ?? null,
        format: r.format ?? null,
        stream: r.stream ? 1 : 0,
        status: r.status ?? null,
        latencyMs: r.latencyMs == null ? null : Math.round(r.latencyMs),
        ttfbMs: r.ttfbMs == null ? null : Math.round(r.ttfbMs),
        costBasis: r.costBasis ?? null,
        partial: r.partial ? 1 : 0,
        sessionId: r.sessionId ?? null,
        agentId: r.agentId ?? null,
        error: r.error ?? null,
      }).lastInsertRowid;
  }

  lastRequestFor(identity) {
    return this.db.prepare("SELECT ts, client, model, status FROM requests WHERE identity = ? ORDER BY id DESC LIMIT 1").get(identity) || null;
  }

  usageFor(identity, sinceMs) {
    return this.db
      .prepare("SELECT model, count(*) AS requests, sum(in_tok) AS inTok, sum(out_tok) AS outTok FROM requests WHERE identity = ? AND ts >= ? GROUP BY model ORDER BY requests DESC")
      .all(identity, sinceMs);
  }

  today(sinceMs) {
    const totals = this.db.prepare("SELECT count(*) AS requests, count(DISTINCT identity) AS people, coalesce(sum(CASE WHEN status >= 400 OR error IS NOT NULL THEN 1 ELSE 0 END), 0) AS errors FROM requests WHERE ts >= ?").get(sinceMs);
    const topPeople = this.db.prepare("SELECT identity, count(*) AS requests FROM requests WHERE ts >= ? GROUP BY identity ORDER BY requests DESC LIMIT 5").all(sinceMs);
    const topModels = this.db.prepare("SELECT model, count(*) AS requests FROM requests WHERE ts >= ? AND model IS NOT NULL GROUP BY model ORDER BY requests DESC LIMIT 5").all(sinceMs);
    return { ...totals, topPeople, topModels };
  }
}
