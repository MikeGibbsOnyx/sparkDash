// Onyx Gateway: the internal API, reachable only over ipc/gateway.sock with the shared secret.
// The Observer calls it; the Gateway never calls the Observer. The Observer checks roles before
// it forwards an admin call, and names the acting person in X-SparkDash-Actor.
import { timingSafeEqual } from "node:crypto";
import { redact } from "../../shared/redact.js";
import { detectProvider } from "../providers/catalog.js";
import { ProviderError } from "../providers/registry.js";
import { safeZone } from "../usage/periods.js";

function equal(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * @param {object} deps
 * @param {string} deps.secret
 * @param {import("../store/state.js").State} deps.state
 * @param {import("../providers/registry.js").Providers} deps.providers
 * @param {import("../policy/grants.js").Grants} deps.grants
 * @param {import("../credentials/gatewayKeys.js").GatewayKeys} deps.keys
 * @param {import("../usage/ledger.js").Usage} deps.usage
 * @param {import("../policy/budgets.js").Budgets} deps.budgets
 * @param {import("../usage/energy.js").Energy} deps.energy
 * @param {ReturnType<import("../config.js").loadConfig>} deps.config
 * @param {string} deps.version
 */
export function createInternalHandler(deps) {
  const { secret, state, providers, grants, keys, usage, budgets, energy, config, version } = deps;
  const RANGE_MS = { "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000, all: null };
  const sinceFor = (range) => {
    const span = RANGE_MS[range] === undefined ? RANGE_MS["7d"] : RANGE_MS[range];
    return span == null ? 0 : Date.now() - span;
  };

  async function body(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 4 * 1024 * 1024) throw new ProviderError(413, "Too large.");
      chunks.push(c);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      throw new ProviderError(400, "The request body isn't valid JSON.");
    }
  }

  function findings() {
    const out = [];
    for (const p of providers.list()) {
      if (p.status === "Failing") out.push({ id: `provider-failing:${p.id}`, severity: "warn", title: `${p.name} key is failing`, detail: p.lastError || "", hint: "Open the Models tab and replace the key." });
    }
    for (const c of providers.conflicts()) {
      out.push({ id: `model-conflict:${c.name}`, severity: "warn", title: `${c.name} is offered by more than one provider`, detail: c.providers, hint: "Switch it off in all but one on the Models tab; requests for it fail until then." });
    }
    for (const k of keys.list()) {
      if (k.state === "expiring") out.push({ id: `key-expiring:${k.id}`, severity: "info", title: `Gateway key ${k.name} expires soon`, detail: new Date(k.expiresAt).toISOString().slice(0, 10), hint: "Create a replacement and revoke this one." });
    }
    for (const s of providers.localServers()) {
      if (!s.reachable) out.push({ id: `local-unreachable:${s.id}`, severity: "info", title: `The model server on ${s.machine} :${s.port} can't be served`, detail: s.fix, hint: s.fix });
    }
    out.push(...budgets.findings());
    const unpriced = usage.summary({ range: "7d", groupBy: "model" }).rows.filter((r) => r.unpricedRequests > 0);
    if (unpriced.length) {
      out.push({ id: "models-unpriced", severity: "info", title: `${unpriced.length === 1 ? `${unpriced[0].key} has` : `${unpriced.length} models have`} no price set`, detail: unpriced.map((r) => r.key).join(", "), hint: "Their requests count as $0 toward budgets. Set prices on the Models tab." });
    }
    return out;
  }

  function overview() {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return {
      enabled: state.enabled,
      version,
      bind: `${config.bindHost}:${config.port}`,
      providers: providers.list().length,
      localServed: providers.localServers().filter((s) => s.serve).length,
      models: providers.models().filter((m) => m.usable).length,
      today: { ...state.today(start.getTime()), ...spendSince(start.getTime()) },
      timeZone: state.timeZone,
      findings: findings(),
      personalKeys: state.personalKeys,
    };
  }

  function spendSince(since) {
    return usage.db
      .prepare(
        `SELECT coalesce(sum(CASE WHEN cost_basis = 'key' THEN cost_usd END), 0) AS cloudUsd, coalesce(sum(CASE WHEN cost_basis = 'local' THEN cost_usd END), 0) AS localUsd,
                coalesce(sum(coalesce(in_tok, 0) + coalesce(out_tok, 0) + coalesce(cache_read_tok, 0) + coalesce(cache_write_tok, 0)), 0) AS tokens
           FROM requests WHERE ts >= ?`
      )
      .get(since);
  }

  /** Admin routes: [method, regex, (match, body, actor, url) => result]. */
  const ADMIN = [
    ["GET", /^\/status$/, () => overview()],
    ["POST", /^\/enable$/, (_m, _b, actor) => {
      state.set("enabled", true);
      const created = grants.ensureDefault(actor);
      state.audit(actor, "gateway.enabled", null, created ? "default grant created" : null);
      return overview();
    }],
    ["POST", /^\/pause$/, (_m, _b, actor) => {
      state.set("enabled", false);
      state.audit(actor, "gateway.paused", null, null);
      return overview();
    }],
    ["POST", /^\/detect$/, (_m, b) => ({ type: detectProvider(b.key) })],
    ["GET", /^\/providers$/, () => ({ providers: providers.list(), conflicts: providers.conflicts() })],
    ["POST", /^\/providers$/, (_m, b, actor) => providers.add({ type: b.type || detectProvider(b.key), key: b.key, name: b.name, baseUrl: b.baseUrl, actor, skipTest: Boolean(b.skipTest), saveAnyway: Boolean(b.saveAnyway) })],
    ["POST", /^\/providers\/([\w-]+)\/test$/, (m) => providers.retest(m[1])],
    ["PUT", /^\/providers\/([\w-]+)\/key$/, (m, b, actor) => providers.replace(m[1], b.key, actor)],
    ["PATCH", /^\/providers\/([\w:.-]+)$/, (m, b, actor) => ({ provider: providers.update(m[1], { ownLogin: b.ownLogin, enabled: b.enabled, injectUsage: b.injectUsage }, actor) })],
    ["GET", /^\/providers\/([\w-]+)\/impact$/, (m) => providers.impact(m[1])],
    ["DELETE", /^\/providers\/([\w-]+)$/, (m, _b, actor) => (providers.remove(m[1], actor), { ok: true })],
    ["GET", /^\/models$/, () => ({ models: providers.models(), conflicts: providers.conflicts() })],
    ["PATCH", /^\/models\/(\d+)$/, (m, b, actor) => (providers.setModelEnabled(Number(m[1]), Boolean(b.enabled), actor), { ok: true })],
    ["PATCH", /^\/models\/(\d+)\/prices$/, (m, b, actor) => (providers.setModelPrices(Number(m[1]), b, actor), { model: providers.models().find((x) => x.id === Number(m[1])) })],
    ["GET", /^\/local-servers$/, () => ({ servers: providers.localServers() })],
    ["PATCH", /^\/local-servers\/([^/]+)$/, (m, b, actor) => ({ server: providers.setServe(decodeURIComponent(m[1]), Boolean(b.serve), actor) })],
    ["GET", /^\/keys$/, () => ({ keys: keys.list() })],
    ["POST", /^\/keys$/, (_m, b, actor) => keys.create({ name: b.name, access: b.access || null, expiry: b.expiry ?? "90", createdBy: actor })],
    ["DELETE", /^\/keys\/(\d+)$/, (m, _b, actor) => ({ key: keys.revoke(Number(m[1]), actor) })],
    ["GET", /^\/grants$/, () => ({ grants: grants.list() })],
    ["POST", /^\/grants$/, (_m, b, actor) => ({ grant: grants.create(b, actor) })],
    ["PATCH", /^\/grants\/(\d+)$/, (m, b, actor) => ({ grant: grants.update(Number(m[1]), b, actor) })],
    ["DELETE", /^\/grants\/(\d+)$/, (m, _b, actor) => (grants.remove(Number(m[1]), actor), { ok: true })],
    // Who would gain or lose access. Body: { id?, draft? } (no draft = the grant removed).
    ["POST", /^\/grants\/preview$/, (_m, b) =>
      grants.preview({ id: b.id == null ? null : Number(b.id), draft: b.draft ?? null }, { directory: state.directory(), keys: keys.list(), models: providers.models().filter((x) => x.usable).map((x) => x.name) })],
    ["GET", /^\/budgets$/, () => ({ budgets: budgets.list(), timeZone: state.timeZone })],
    ["POST", /^\/budgets$/, (_m, b, actor) => ({ budget: budgets.create(b, actor) })],
    ["PATCH", /^\/budgets\/(\d+)$/, (m, b, actor) => ({ budget: budgets.update(Number(m[1]), b, actor) })],
    ["DELETE", /^\/budgets\/(\d+)$/, (m, _b, actor) => (budgets.remove(Number(m[1]), actor), { ok: true })],
    ["GET", /^\/usage$/, (_m, _b, _a, url) => usage.summary({ range: url.searchParams.get("range") || "7d", groupBy: url.searchParams.get("groupBy") || "person" })],
    ["GET", /^\/usage\/daily$/, (_m, _b, _a, url) => usage.daily({ range: url.searchParams.get("range") || "30d" })],
    ["GET", /^\/usage\/energy$/, (_m, _b, _a, url) => energy.summary(sinceFor(url.searchParams.get("range") || "7d"))],
    // Gateway traffic to local models, for the Token totals page.
    ["GET", /^\/usage\/local$/, (_m, _b, _a, url) => ({ models: usage.localTotals(sinceFor(url.searchParams.get("range") || "all")) })],
    ["GET", /^\/settings$/, () => ({ personalKeys: state.personalKeys, timeZone: state.timeZone })],
    ["PATCH", /^\/settings$/, (_m, b, actor) => {
      if (b.personalKeys !== undefined) {
        state.set("personal_keys", Boolean(b.personalKeys));
        state.audit(actor, "settings.personal_keys", null, b.personalKeys ? "on" : "off");
      }
      return { personalKeys: state.personalKeys, timeZone: state.timeZone };
    }],
  ];

  return async function handle(req, res) {
    const send = (status, obj) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (!equal(req.headers["x-sparkdash-internal"], secret)) return send(401, { error: "Missing or wrong internal secret." });
    const url = new URL(req.url, "http://internal");
    const p = url.pathname;
    try {
      if (req.method === "GET" && p === "/internal/health") return send(200, { ok: true, ...overview() });
      if (req.method === "PUT" && p === "/internal/directory") {
        state.setDirectory(await body(req));
        return send(200, { ok: true });
      }
      if (req.method === "PUT" && p === "/internal/inventory") {
        const b = await body(req);
        providers.setInventory(Array.isArray(b.servers) ? b.servers : []);
        return send(200, { ok: true, servers: providers.localServers().length });
      }
      if (req.method === "POST" && p === "/internal/energy") {
        // Each minute: the Settings time zone and electricity rate, and each machine's energy.
        const b = await body(req);
        if (typeof b.timeZone === "string" && b.timeZone && safeZone(b.timeZone) === b.timeZone && b.timeZone !== state.timeZone) {
          state.set("time_zone", b.timeZone);
          usage.rebuildDaily();
          budgets.reset();
        }
        const stored = energy.ingest({ rate: b.rate == null ? null : Number(b.rate), minutes: b.minutes });
        energy.settle();
        return send(200, { ok: true, stored });
      }
      if (req.method === "GET" && p === "/internal/events") {
        keys.takeExpiryWarnings();
        return send(200, { events: state.eventsSince(url.searchParams.get("since")) });
      }
      if (p.startsWith("/internal/admin/")) {
        const sub = p.slice("/internal/admin".length);
        const actor = decodeURIComponent(String(req.headers["x-sparkdash-actor"] || "sparkDash")).slice(0, 200);
        for (const [method, re, fn] of ADMIN) {
          const m = re.exec(sub);
          if (m && method === req.method) {
            const b = method === "GET" || method === "DELETE" ? {} : await body(req);
            return send(200, await fn(m, b, actor, url));
          }
        }
      }
      return send(404, { error: `No internal route ${req.method} ${p}.` });
    } catch (err) {
      if (err instanceof ProviderError || err?.status) return send(err.status, { error: err.message });
      console.error(`[gateway] internal ${req.method} ${p} failed: ${redact(err?.stack || err?.message || err)}`);
      return send(500, { error: "The Gateway hit an internal error. Check its log." });
    }
  };
}
