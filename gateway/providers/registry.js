// Onyx Gateway: provider keys (write-only), their models, and local model servers.
import crypto from "node:crypto";
import { last4 } from "../../shared/redact.js";
import { PROVIDER_TYPES, testKey } from "./catalog.js";
import { checkOutboundUrl } from "../security.js";

const DAY = 24 * 60 * 60 * 1000;

export class ProviderError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

/** "Spark 1" -> "spark-1": the machine part of a local model name. */
function options(p) {
  try {
    return JSON.parse(p?.options || "{}") || {};
  } catch {
    return {};
  }
}

export function machineSlug(name) {
  return String(name || "local").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "local";
}

export class Providers {
  /**
   * @param {import("better-sqlite3").Database} db
   * @param {{ vault: { seal: (s: string) => string, open: (s: string) => string }, audit: Function, now?: () => number,
   *           fetchImpl?: typeof fetch, envKeys?: Record<string, string>, checkUrl?: typeof checkOutboundUrl }} opts
   */
  constructor(db, opts) {
    this.db = db;
    this.vault = opts.vault;
    this.audit = opts.audit;
    this.now = opts.now || Date.now;
    this.fetchImpl = opts.fetchImpl || fetch;
    this.checkUrl = opts.checkUrl || checkOutboundUrl;
    /** Keys from GATEWAY_*_API_KEY live only in memory. */
    this.envKeys = new Map();
    for (const [type, key] of Object.entries(opts.envKeys || {})) if (key) this.envKeys.set(`env-${type}`, key);
  }

  /** Create the provider rows for environment-variable keys, and drop rows whose variable is gone. */
  async syncEnvProviders({ test = true } = {}) {
    for (const row of this.db.prepare("SELECT id FROM providers WHERE key_source = 'env'").all()) {
      if (!this.envKeys.has(row.id)) this.db.prepare("DELETE FROM providers WHERE id = ?").run(row.id);
    }
    for (const [id, key] of this.envKeys) {
      const type = id.slice(4);
      const def = PROVIDER_TYPES[type];
      this.db
        .prepare(
          `INSERT INTO providers (id, type, name, base_url, key_source, key_last4, added_by, added_at) VALUES (?, ?, ?, ?, 'env', ?, 'environment variable', ?)
           ON CONFLICT(id) DO UPDATE SET key_last4 = excluded.key_last4`
        )
        .run(id, type, def.label, def.baseUrl, last4(key), this.now());
      if (test) await this.retest(id).catch(() => {});
    }
  }

  // ─── Reading ────────────────────────────────────────────
  row(id) {
    return this.db.prepare("SELECT * FROM providers WHERE id = ?").get(id) || null;
  }

  /** The key for a provider. Internal only: nothing returns this to a client. */
  secretFor(id) {
    if (this.envKeys.has(id)) return this.envKeys.get(id);
    const row = this.db.prepare("SELECT ciphertext FROM provider_secrets WHERE provider_id = ?").get(id);
    return row ? this.vault.open(row.ciphertext) : "";
  }

  present(p) {
    const counts = this.db.prepare("SELECT count(*) AS total, sum(enabled) AS enabled FROM models WHERE provider_id = ?").get(p.id);
    const now = this.now();
    let status = p.status === "working" ? "Working" : p.status === "failing" ? "Failing" : "Not tested";
    const lastActivity = p.last_used_at ?? p.added_at;
    if (status === "Working" && now - lastActivity > 30 * DAY) status = "Unused 30 days";
    return {
      id: p.id,
      type: p.type,
      typeLabel: PROVIDER_TYPES[p.type]?.label || p.type,
      name: p.name,
      baseUrl: p.base_url,
      keyLast4: p.key_last4,
      keySource: p.key_source,
      addedBy: p.added_by,
      addedAt: p.added_at,
      lastUsedAt: p.last_used_at,
      status,
      lastError: p.last_error,
      lastTestedAt: p.last_tested_at,
      ownLogin: Boolean(p.own_login),
      ownLoginCapable: Boolean(PROVIDER_TYPES[p.type]?.ownLoginCapable),
      enabled: Boolean(p.enabled),
      injectUsage: options(p).injectUsage !== false,
      modelCount: counts.total || 0,
      modelsEnabled: counts.enabled || 0,
    };
  }

  list() {
    return this.db.prepare("SELECT * FROM providers WHERE type != 'local' ORDER BY added_at").all().map((p) => this.present(p));
  }

  models() {
    return this.db
      .prepare(
        `SELECT m.id, m.name, m.upstream_name, m.enabled, m.provider_id, p.name AS provider_name, p.type AS provider_type, p.enabled AS provider_enabled,
                m.price_in, m.price_out, m.price_cache_read, m.price_cache_write
           FROM models m JOIN providers p ON p.id = m.provider_id ORDER BY m.name`
      )
      .all()
      .map((m) => ({
        id: m.id,
        name: m.name,
        providerId: m.provider_id,
        providerName: m.provider_name,
        providerType: m.provider_type,
        enabled: Boolean(m.enabled),
        usable: Boolean(m.enabled && m.provider_enabled),
        prices: { in: m.price_in, out: m.price_out, cacheRead: m.price_cache_read, cacheWrite: m.price_cache_write },
        // Local models are costed from energy; own-login requests are Subscription. Only cloud keys need prices.
        needsPrice: m.provider_type !== "local",
      }));
  }

  /** Names served by more than one enabled provider: a config error, never resolved silently. */
  conflicts() {
    return this.db
      .prepare(
        `SELECT m.name, group_concat(p.name, ', ') AS providers FROM models m JOIN providers p ON p.id = m.provider_id
          WHERE m.enabled = 1 AND p.enabled = 1 GROUP BY m.name HAVING count(*) > 1`
      )
      .all();
  }

  // ─── Saving keys ────────────────────────────────────────
  /**
   * Test and save. A failed test saves nothing unless `saveAnyway`; `skipTest` saves as Not tested.
   * @returns {Promise<{ saved: boolean, provider?: object, ok: boolean | null, message: string, details?: string }>}
   */
  async add({ type, key, name, baseUrl, actor, skipTest = false, saveAnyway = false }) {
    const def = PROVIDER_TYPES[type];
    if (!def || type === "local") throw new ProviderError(400, "Pick Anthropic, OpenAI, Gemini or OpenRouter.");
    const k = String(key || "").trim().replace(/\s+/g, "");
    if (!k) throw new ProviderError(400, "Paste a provider key first.");
    const base = (baseUrl || def.baseUrl).replace(/\/+$/, "");
    const urlProblem = await this.checkUrl(base);
    if (urlProblem) throw new ProviderError(400, urlProblem);
    const result = skipTest ? null : await testKey(type, k, { baseUrl: base, fetchImpl: this.fetchImpl });
    if (result && !result.ok && !saveAnyway) return { saved: false, ok: false, message: result.message, details: result.details };

    const id = `${type}-${crypto.randomBytes(4).toString("hex")}`;
    const now = this.now();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO providers (id, type, name, base_url, status, last_error, last_tested_at, key_last4, key_source, added_by, added_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'saved', ?, ?)`
        )
        .run(id, type, name || def.label, base, result ? (result.ok ? "working" : "failing") : "not_tested", result && !result.ok ? result.message : null, result ? now : null, last4(k), actor, now);
      this.db.prepare("INSERT INTO provider_secrets (provider_id, ciphertext) VALUES (?, ?)").run(id, this.vault.seal(k));
      if (result?.ok) this.syncModels(id, result.models);
    })();
    this.audit(actor, "provider.added", name || def.label, `…${last4(k)} ${result ? (result.ok ? "working" : "failing") : "not tested"}`);
    return {
      saved: true,
      provider: this.present(this.row(id)),
      ok: result ? result.ok : null,
      message: result ? (result.ok ? result.message : `Saved. ${result.message}`) : "Saved. Not tested.",
      details: result?.details,
    };
  }

  /** Re-test the saved key; refreshes status and the model list. */
  async retest(id) {
    const p = this.row(id);
    if (!p) throw new ProviderError(404, "That provider no longer exists.");
    const result = await testKey(p.type, this.secretFor(id), { baseUrl: p.base_url, fetchImpl: this.fetchImpl });
    this.db
      .prepare("UPDATE providers SET status = ?, last_error = ?, last_tested_at = ? WHERE id = ?")
      .run(result.ok ? "working" : "failing", result.ok ? null : result.message, this.now(), id);
    if (result.ok) this.syncModels(id, result.models);
    return { ok: result.ok, message: result.message, details: result.details, provider: this.present(this.row(id)) };
  }

  /** Replace key: the new key is tested first; on failure the old key stays. */
  async replace(id, key, actor) {
    const p = this.row(id);
    if (!p) throw new ProviderError(404, "That provider no longer exists.");
    if (p.key_source === "env") throw new ProviderError(409, `This key is set by the environment variable GATEWAY_${p.type.toUpperCase()}_API_KEY. Change it there and restart the Gateway.`);
    const k = String(key || "").trim().replace(/\s+/g, "");
    const result = await testKey(p.type, k, { baseUrl: p.base_url, fetchImpl: this.fetchImpl });
    if (!result.ok) return { replaced: false, ok: false, message: `${result.message} The old key is still in use.`, details: result.details };
    this.db.transaction(() => {
      this.db.prepare("UPDATE provider_secrets SET ciphertext = ? WHERE provider_id = ?").run(this.vault.seal(k), id);
      this.db.prepare("UPDATE providers SET key_last4 = ?, status = 'working', last_error = NULL, last_tested_at = ? WHERE id = ?").run(last4(k), this.now(), id);
      this.syncModels(id, result.models);
    })();
    this.audit(actor, "provider.key_replaced", p.name, `…${p.key_last4} -> …${last4(k)}`);
    return { replaced: true, ok: true, message: result.message, provider: this.present(this.row(id)) };
  }

  /** What removing a provider would affect, from the last 24 hours. */
  impact(id) {
    const p = this.row(id);
    if (!p) throw new ProviderError(404, "That provider no longer exists.");
    const since = this.now() - DAY;
    const r = this.db
      .prepare("SELECT count(*) AS requests, count(DISTINCT identity) AS people, count(DISTINCT model) AS models FROM requests WHERE provider_id = ? AND ts >= ?")
      .get(id, since);
    const modelCount = this.db.prepare("SELECT count(*) AS n FROM models WHERE provider_id = ? AND enabled = 1").get(id).n;
    return { people: r.people, requests: r.requests, modelsUsed: r.models, modelsServed: modelCount };
  }

  remove(id, actor) {
    const p = this.row(id);
    if (!p) throw new ProviderError(404, "That provider no longer exists.");
    if (p.key_source === "env") throw new ProviderError(409, `This key is set by GATEWAY_${p.type.toUpperCase()}_API_KEY. Remove the variable and restart the Gateway.`);
    this.db.prepare("DELETE FROM providers WHERE id = ?").run(id);
    this.audit(actor, "provider.removed", p.name, `…${p.key_last4}`);
  }

  update(id, { ownLogin, enabled, injectUsage }, actor) {
    const p = this.row(id);
    if (!p) throw new ProviderError(404, "That provider no longer exists.");
    if (ownLogin !== undefined) {
      if (ownLogin && !PROVIDER_TYPES[p.type]?.ownLoginCapable) throw new ProviderError(400, `${p.name} doesn't support people's own subscriptions.`);
      this.db.prepare("UPDATE providers SET own_login = ? WHERE id = ?").run(ownLogin ? 1 : 0, id);
      this.audit(actor, "provider.own_login", p.name, ownLogin ? "on" : "off");
    }
    if (enabled !== undefined) {
      this.db.prepare("UPDATE providers SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
      this.audit(actor, "provider.enabled", p.name, enabled ? "on" : "off");
    }
    if (injectUsage !== undefined) {
      this.db.prepare("UPDATE providers SET options = ? WHERE id = ?").run(JSON.stringify({ ...options(p), injectUsage: Boolean(injectUsage) }), id);
      this.audit(actor, "provider.stream_usage", p.name, injectUsage ? "on" : "off");
    }
    return this.present(this.row(id));
  }

  setModelEnabled(modelId, enabled, actor) {
    const m = this.db.prepare("SELECT * FROM models WHERE id = ?").get(modelId);
    if (!m) throw new ProviderError(404, "That model is no longer listed.");
    this.db.prepare("UPDATE models SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, modelId);
    this.audit(actor, "model.enabled", m.name, enabled ? "on" : "off");
  }

  /**
   * Set a model's prices, in USD per million tokens. null clears one. Requests already made keep
   * the price they were charged at.
   * @param {{ in?: number | null, out?: number | null, cacheRead?: number | null, cacheWrite?: number | null }} prices
   */
  setModelPrices(modelId, prices, actor) {
    const m = this.db.prepare("SELECT * FROM models WHERE id = ?").get(modelId);
    if (!m) throw new ProviderError(404, "That model is no longer listed.");
    const col = { in: "price_in", out: "price_out", cacheRead: "price_cache_read", cacheWrite: "price_cache_write" };
    const next = {};
    for (const [k, c] of Object.entries(col)) {
      if (!(k in (prices || {}))) {
        next[c] = m[c];
        continue;
      }
      const v = prices[k];
      if (v === null || v === "") next[c] = null;
      else {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0 || n > 10_000) throw new ProviderError(400, "A price is dollars per million tokens: a number from 0 to 10,000.");
        next[c] = n;
      }
    }
    if ((next.price_in == null) !== (next.price_out == null)) throw new ProviderError(400, "Set both the input and the output price, or neither.");
    this.db
      .prepare("UPDATE models SET price_in = @price_in, price_out = @price_out, price_cache_read = @price_cache_read, price_cache_write = @price_cache_write WHERE id = @id")
      .run({ ...next, id: modelId });
    const fmt = (v) => (v == null ? "-" : `$${v}`);
    this.audit(actor, "model.price", m.name, `in ${fmt(next.price_in)}, out ${fmt(next.price_out)}, cache read ${fmt(next.price_cache_read)}, cache write ${fmt(next.price_cache_write)} per million`);
  }

  /** Keep the model list in step with the provider; existing switches keep their state. */
  syncModels(providerId, names, toUpstream = (n) => ({ name: n, upstream: n })) {
    const wanted = new Map(names.map((n) => toUpstream(n)).map((m) => [m.name, m.upstream]));
    const existing = this.db.prepare("SELECT name FROM models WHERE provider_id = ?").all(providerId).map((r) => r.name);
    const del = this.db.prepare("DELETE FROM models WHERE provider_id = ? AND name = ?");
    for (const name of existing) if (!wanted.has(name)) del.run(providerId, name);
    const ins = this.db.prepare("INSERT INTO models (provider_id, name, upstream_name) VALUES (?, ?, ?) ON CONFLICT(provider_id, name) DO UPDATE SET upstream_name = excluded.upstream_name");
    for (const [name, upstream] of wanted) ins.run(providerId, name, upstream);
  }

  markUsed(id) {
    const now = this.now();
    this.db.prepare("UPDATE providers SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)").run(now, id, now - 60_000);
  }

  // ─── Routing ────────────────────────────────────────────
  /**
   * The one enabled provider model for a name in a format.
   * @returns {{ provider: object, model: object } | { error: "unknown" | "format" | "conflict", message: string }}
   */
  resolve(name, format) {
    const rows = this.db
      .prepare(
        `SELECT m.*, p.type, p.base_url, p.name AS provider_name, p.own_login, p.id AS pid, p.options AS provider_options
           FROM models m JOIN providers p ON p.id = m.provider_id
          WHERE m.name = ? AND m.enabled = 1 AND p.enabled = 1`
      )
      .all(name);
    if (rows.length > 1) {
      return { error: "conflict", message: `${name} is offered by more than one provider (${rows.map((r) => r.provider_name).join(", ")}). An Admin must switch it off in all but one on the Models tab.` };
    }
    if (rows.length === 0) return { error: "unknown", message: `The model ${name} isn't available through this gateway.` };
    const r = rows[0];
    if (!PROVIDER_TYPES[r.type]?.formats.includes(format)) {
      return { error: "format", message: `${name} is served by ${r.provider_name}, which doesn't speak this API format. Use that provider's own format for this model.` };
    }
    return {
      provider: { id: r.pid, type: r.type, baseUrl: r.base_url, name: r.provider_name, ownLogin: Boolean(r.own_login), injectUsage: options({ options: r.provider_options }).injectUsage !== false },
      model: { id: r.id, name: r.name, upstream: r.upstream_name, price_in: r.price_in, price_out: r.price_out, price_cache_read: r.price_cache_read, price_cache_write: r.price_cache_write },
    };
  }

  // ─── Local model servers (inventory from the Observer) ──
  /**
   * @param {Array<{ machine: string, address: string, port: number, backend?: string, models?: string[], apiKey?: string,
   *                 reachable?: boolean, up?: boolean }>} servers
   */
  setInventory(servers) {
    const now = this.now();
    const seen = new Set();
    const upsert = this.db.prepare(
      `INSERT INTO local_servers (id, machine, address, port, backend, models, api_key_ciphertext, reachable, up, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET machine = excluded.machine, address = excluded.address, port = excluded.port, backend = excluded.backend,
         models = excluded.models, api_key_ciphertext = excluded.api_key_ciphertext, reachable = excluded.reachable, up = excluded.up, updated_at = excluded.updated_at`
    );
    this.db.transaction(() => {
      for (const s of servers) {
        const machine = machineSlug(s.machine);
        const id = `${machine}:${Number(s.port)}`;
        seen.add(id);
        upsert.run(id, machine, String(s.address), Number(s.port), s.backend || null, JSON.stringify(s.models || []), s.apiKey ? this.vault.seal(s.apiKey) : null, s.reachable === false ? 0 : 1, s.up ? 1 : 0, now);
        const served = this.db.prepare("SELECT serve FROM local_servers WHERE id = ?").get(id);
        if (served?.serve) this.#syncLocalProvider(id);
      }
      for (const row of this.db.prepare("SELECT id FROM local_servers").all()) {
        if (!seen.has(row.id)) {
          this.db.prepare("DELETE FROM providers WHERE id = ?").run(`local-${row.id}`);
          this.db.prepare("DELETE FROM local_servers WHERE id = ?").run(row.id);
        }
      }
    })();
  }

  localServers() {
    return this.db
      .prepare("SELECT * FROM local_servers ORDER BY machine, port")
      .all()
      .map((s) => ({
        id: s.id,
        machine: s.machine,
        address: s.address,
        port: s.port,
        backend: s.backend,
        models: JSON.parse(s.models).map((m) => `${s.machine}/${m}`),
        hasApiKey: Boolean(s.api_key_ciphertext),
        reachable: Boolean(s.reachable),
        up: Boolean(s.up),
        serve: Boolean(s.serve),
        fix: s.reachable ? null : `The server on ${s.machine} only listens on its own loopback. Bind it to a LAN or tailnet address so the Gateway can reach it.`,
      }));
  }

  /** Serve through the gateway: a local server becomes a provider whose models are <machine>/<model>. */
  setServe(id, on, actor) {
    const s = this.db.prepare("SELECT * FROM local_servers WHERE id = ?").get(id);
    if (!s) throw new ProviderError(404, "That server is no longer detected.");
    if (on && !s.reachable) throw new ProviderError(409, `The server on ${s.machine} only listens on its own loopback. Bind it to a LAN or tailnet address so the Gateway can reach it.`);
    this.db.prepare("UPDATE local_servers SET serve = ? WHERE id = ?").run(on ? 1 : 0, id);
    if (on) this.#syncLocalProvider(id);
    else this.db.prepare("DELETE FROM providers WHERE id = ?").run(`local-${id}`);
    this.audit(actor, "local_server.serve", id, on ? "on" : "off");
    return this.localServers().find((x) => x.id === id);
  }

  #syncLocalProvider(id) {
    const s = this.db.prepare("SELECT * FROM local_servers WHERE id = ?").get(id);
    const pid = `local-${id}`;
    const host = s.address.includes(":") ? `[${s.address}]` : s.address;
    this.db
      .prepare(
        `INSERT INTO providers (id, type, name, base_url, status, key_source, added_by, added_at) VALUES (?, 'local', ?, ?, ?, 'local', 'sparkDash', ?)
         ON CONFLICT(id) DO UPDATE SET base_url = excluded.base_url, status = excluded.status`
      )
      .run(pid, `${s.machine} :${s.port}`, `http://${host}:${s.port}`, s.up ? "working" : "failing", this.now());
    if (s.api_key_ciphertext) {
      this.db.prepare("INSERT INTO provider_secrets (provider_id, ciphertext) VALUES (?, ?) ON CONFLICT(provider_id) DO UPDATE SET ciphertext = excluded.ciphertext").run(pid, s.api_key_ciphertext);
    } else {
      this.db.prepare("DELETE FROM provider_secrets WHERE provider_id = ?").run(pid);
    }
    this.syncModels(pid, JSON.parse(s.models), (m) => ({ name: `${s.machine}/${m}`, upstream: m }));
  }
}
