// Onyx Gateway: the usage ledger. Each finished request is written once with its tokens and cost
// (at the price it was charged, kept with it) and added to the daily rollup. Local requests get
// their energy cost later, as the Observer's energy minutes arrive (usage/energy.js).
import { localDay, safeZone } from "./periods.js";

/** Prices per million tokens, as stored with each request. null when the model has no price. */
export function priceSnapshot(m) {
  if (!m || (m.price_in == null && m.price_out == null)) return null;
  const pin = m.price_in ?? 0;
  return {
    in: pin,
    out: m.price_out ?? 0,
    // Without a cache price, cached tokens are charged at the input price (never under-counted).
    cacheRead: m.price_cache_read ?? pin,
    cacheWrite: m.price_cache_write ?? pin,
  };
}

/** USD for a usage reading at a price snapshot. */
export function costOf(u, p) {
  if (!p || !u) return null;
  const usd = ((u.in ?? 0) * p.in + (u.out ?? 0) * p.out + (u.cacheRead ?? 0) * p.cacheRead + (u.cacheWrite ?? 0) * p.cacheWrite) / 1e6;
  return Math.round(usd * 1e8) / 1e8;
}

export function totalTokens(u) {
  return (u?.in ?? 0) + (u?.out ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0);
}

const RANGES = { "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000, all: null };
export const GROUP_BY = ["person", "group", "model", "provider", "client", "session"];

export class Usage {
  /** @param {import("better-sqlite3").Database} db */
  constructor(db, { now = Date.now, timeZone = () => "UTC" } = {}) {
    this.db = db;
    this.now = now;
    this.timeZone = () => safeZone(timeZone());
    /** In-flight requests by id, so local energy isn't settled under a request still running. */
    this.inflight = new Map();
    this._next = 1;
    this._insert = db.prepare(
      `INSERT INTO requests (ts, end_ts, identity, via, kind, key_name, groups, device, client, provider_id, model, format, stream, status, latency_ms, ttfb_ms,
                             in_tok, out_tok, cache_read_tok, cache_write_tok, cost_usd, cost_basis, price_snapshot, partial, usage_state, session_id, agent_id, error)
       VALUES (@ts, @endTs, @identity, @via, @kind, @keyName, @groups, @device, @client, @providerId, @model, @format, @stream, @status, @latencyMs, @ttfbMs,
               @in, @out, @cacheRead, @cacheWrite, @costUsd, @costBasis, @priceSnapshot, @partial, @usageState, @sessionId, @agentId, @error)`
    );
    this._roll = db.prepare(
      `INSERT INTO usage_daily (day, identity, model, provider_id, cost_basis, client, requests, in_tok, out_tok, cache_read_tok, cache_write_tok, cost_usd)
       VALUES (@day, @identity, @model, @providerId, @costBasis, @client, @requests, @in, @out, @cacheRead, @cacheWrite, @costUsd)
       ON CONFLICT (day, identity, model, provider_id, cost_basis, client) DO UPDATE SET
         requests = requests + excluded.requests, in_tok = in_tok + excluded.in_tok, out_tok = out_tok + excluded.out_tok,
         cache_read_tok = cache_read_tok + excluded.cache_read_tok, cache_write_tok = cache_write_tok + excluded.cache_write_tok,
         cost_usd = cost_usd + excluded.cost_usd`
    );
  }

  // ─── In flight ──────────────────────────────────────────
  begin(providerId, ts) {
    const id = this._next++;
    this.inflight.set(id, { providerId, ts });
    return id;
  }

  end(id) {
    this.inflight.delete(id);
  }

  /** Is a request to a provider whose id starts with `prefix` still running, started before `beforeMs`? */
  busy(prefix, beforeMs) {
    for (const r of this.inflight.values()) if (r.providerId?.startsWith(prefix) && r.ts < beforeMs) return true;
    return false;
  }

  // ─── Recording ──────────────────────────────────────────
  /**
   * Write one finished request and add it to the rollup. Returns the row id.
   * @param {object} r
   */
  record(r) {
    const u = r.usage || {};
    const row = {
      ts: r.ts,
      endTs: r.endTs ?? r.ts + Math.round(r.latencyMs ?? 0),
      identity: r.identity,
      via: r.via,
      kind: r.kind ?? null,
      keyName: r.keyName ?? null,
      groups: JSON.stringify(r.groups || []),
      device: r.device ?? null,
      client: r.client ?? null,
      providerId: r.providerId ?? null,
      model: r.model ?? null,
      format: r.format ?? null,
      stream: r.stream ? 1 : 0,
      status: r.status ?? null,
      latencyMs: r.latencyMs == null ? null : Math.round(r.latencyMs),
      ttfbMs: r.ttfbMs == null ? null : Math.round(r.ttfbMs),
      in: u.in ?? null,
      out: u.out ?? null,
      cacheRead: u.cacheRead ?? null,
      cacheWrite: u.cacheWrite ?? null,
      costUsd: r.costUsd ?? null,
      costBasis: r.costBasis ?? null,
      priceSnapshot: r.priceSnapshot ? JSON.stringify(r.priceSnapshot) : null,
      partial: r.partial ? 1 : 0,
      usageState: r.usageState ?? null,
      sessionId: r.sessionId ?? null,
      agentId: r.agentId ?? null,
      error: r.error ?? null,
    };
    let id;
    this.db.transaction(() => {
      id = Number(this._insert.run(row).lastInsertRowid);
      this._roll.run({
        day: localDay(row.ts, this.timeZone()),
        identity: row.identity,
        model: row.model ?? "",
        providerId: row.providerId ?? "",
        costBasis: row.costBasis ?? "",
        client: row.client ?? "",
        requests: 1,
        in: row.in ?? 0,
        out: row.out ?? 0,
        cacheRead: row.cacheRead ?? 0,
        cacheWrite: row.cacheWrite ?? 0,
        costUsd: row.costUsd ?? 0,
      });
    })();
    return id;
  }

  /** Add cost to a recorded request (local energy, settled later). */
  addCost(requestId, usd) {
    const r = this.db.prepare("SELECT ts, identity, model, provider_id, cost_basis, client FROM requests WHERE id = ?").get(requestId);
    if (!r || !(usd > 0)) return;
    this.db.prepare("UPDATE requests SET cost_usd = coalesce(cost_usd, 0) + ? WHERE id = ?").run(usd, requestId);
    this._roll.run({ day: localDay(r.ts, this.timeZone()), identity: r.identity, model: r.model ?? "", providerId: r.provider_id ?? "", costBasis: r.cost_basis ?? "", client: r.client ?? "", requests: 0, in: 0, out: 0, cacheRead: 0, cacheWrite: 0, costUsd: usd });
  }

  /** The time zone changed: days are re-cut from the request log. */
  rebuildDaily() {
    const tz = this.timeZone();
    const page = this.db.prepare("SELECT id, ts, identity, model, provider_id, cost_basis, client, in_tok, out_tok, cache_read_tok, cache_write_tok, cost_usd FROM requests WHERE id > ? ORDER BY id LIMIT 5000");
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM usage_daily").run();
      for (let after = 0; ; ) {
        const rows = page.all(after);
        if (!rows.length) break;
        for (const r of rows) {
          this._roll.run({ day: localDay(r.ts, tz), identity: r.identity, model: r.model ?? "", providerId: r.provider_id ?? "", costBasis: r.cost_basis ?? "", client: r.client ?? "", requests: 1, in: r.in_tok ?? 0, out: r.out_tok ?? 0, cacheRead: r.cache_read_tok ?? 0, cacheWrite: r.cache_write_tok ?? 0, costUsd: r.cost_usd ?? 0 });
        }
        after = rows.at(-1).id;
      }
    })();
  }

  // ─── Usage views ────────────────────────────────────────
  /**
   * Totals for a range grouped by one dimension.
   * @param {{ range?: string, groupBy?: string, identity?: string }} q
   */
  summary({ range = "7d", groupBy = "person", identity } = {}) {
    const span = Object.prototype.hasOwnProperty.call(RANGES, range) ? RANGES[range] : RANGES["7d"];
    const since = span == null ? 0 : this.now() - span;
    const by = GROUP_BY.includes(groupBy) ? groupBy : "person";
    const key = {
      person: "r.identity",
      group: "g.value",
      model: "r.model",
      provider: "coalesce(p.name, r.provider_id)",
      client: "r.client",
      session: "r.session_id",
    }[by];
    const join = by === "group" ? "JOIN json_each(r.groups) g" : "";
    const where = ["r.ts >= @since"];
    if (identity) where.push("r.identity = @identity");
    const rows = this.db
      .prepare(
        `SELECT ${key} AS key, count(*) AS requests,
                coalesce(sum(r.in_tok), 0) AS inTok, coalesce(sum(r.out_tok), 0) AS outTok,
                coalesce(sum(r.cache_read_tok), 0) AS cacheReadTok, coalesce(sum(r.cache_write_tok), 0) AS cacheWriteTok,
                coalesce(sum(CASE WHEN r.cost_basis = 'key' THEN r.cost_usd END), 0) AS cloudUsd,
                coalesce(sum(CASE WHEN r.cost_basis = 'local' THEN r.cost_usd END), 0) AS localUsd,
                sum(CASE WHEN r.cost_basis = 'subscription' THEN 1 ELSE 0 END) AS subscriptionRequests,
                sum(CASE WHEN r.cost_basis = 'key' AND r.cost_usd IS NULL AND r.usage_state IN ('ok', 'partial') THEN 1 ELSE 0 END) AS unpricedRequests,
                sum(CASE WHEN r.cost_basis = 'local' AND r.cost_usd IS NULL THEN 1 ELSE 0 END) AS localPending,
                sum(r.partial) AS partialRequests,
                max(r.ts) AS lastTs
           FROM requests r LEFT JOIN providers p ON p.id = r.provider_id ${join}
          WHERE ${where.join(" AND ")}
          GROUP BY key ORDER BY (cloudUsd + localUsd) DESC, requests DESC LIMIT 500`
      )
      .all({ since, identity: identity ?? null });
    return { range, groupBy: by, since, rows };
  }

  /** Cost and tokens per local day for a range, for the chart. */
  daily({ range = "30d", identity } = {}) {
    const span = Object.prototype.hasOwnProperty.call(RANGES, range) ? RANGES[range] : RANGES["30d"];
    const tz = this.timeZone();
    const fromDay = span == null ? "0000-00-00" : localDay(this.now() - span, tz);
    const rows = this.db
      .prepare(
        `SELECT day, sum(requests) AS requests, sum(in_tok + out_tok + cache_read_tok + cache_write_tok) AS tokens,
                sum(CASE WHEN cost_basis = 'key' THEN cost_usd ELSE 0 END) AS cloudUsd,
                sum(CASE WHEN cost_basis = 'local' THEN cost_usd ELSE 0 END) AS localUsd
           FROM usage_daily WHERE day >= ? ${identity ? "AND identity = ?" : ""} GROUP BY day ORDER BY day`
      )
      .all(...(identity ? [fromDay, identity] : [fromDay]));
    return { timeZone: tz, rows };
  }

  /** Requests and tokens through the Gateway to each local model, for the Token totals page. */
  localTotals(sinceMs = 0) {
    return this.db
      .prepare(
        `SELECT r.model, count(*) AS requests, count(DISTINCT r.identity) AS people,
                coalesce(sum(r.in_tok), 0) + coalesce(sum(r.cache_read_tok), 0) AS promptTokens, coalesce(sum(r.out_tok), 0) AS completionTokens,
                coalesce(sum(r.cost_usd), 0) AS energyUsd
           FROM requests r WHERE r.cost_basis = 'local' AND r.ts >= ? GROUP BY r.model ORDER BY completionTokens DESC`
      )
      .all(sinceMs);
  }
}
