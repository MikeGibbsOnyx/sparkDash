// Onyx: the Observer side of the internal API. Pushes the directory and the local model server
// inventory, forwards admin calls (roles are checked by server/access before they get here),
// imports Gateway audit events into Activity, and publishes the Gateway on the tailnet.
import crypto from "node:crypto";
import { llmProbeHost } from "../collectors/llmHost.js";
import { createGatewayClient, GatewayDown } from "./client.js";
import { publish, publishStatus } from "./publish.js";
import { createEnergyPusher } from "./energy.js";

const GATEWAY_PORT = Number(process.env.GATEWAY_PORT || 5556);

/** Plain-language Activity messages for Gateway audit actions. */
export function describeEvent(e) {
  const who = e.actor;
  const t = e.target;
  const d = e.detail;
  switch (e.action) {
    case "gateway.enabled":
      return { severity: "success", message: `${who} turned on the AI gateway${d ? ` (${d})` : ""}` };
    case "gateway.paused":
      return { severity: "warn", message: `${who} paused the AI gateway` };
    case "provider.added":
      return { severity: "info", message: `${who} added a ${t} provider key (${d})` };
    case "provider.key_replaced":
      return { severity: "info", message: `${who} replaced the ${t} provider key (${d})` };
    case "provider.removed":
      return { severity: "warn", message: `${who} removed the ${t} provider key (${d})` };
    case "provider.own_login":
      return { severity: "info", message: `${who} turned ${d} own subscriptions for ${t}` };
    case "key.created":
      return { severity: "info", message: `${who} created gateway key ${t} (${d})` };
    case "key.revoked":
      return { severity: "warn", message: `${who} revoked gateway key ${t}` };
    case "key.expiring":
      return { severity: "warn", message: `Gateway key ${t} expires ${String(d).slice(0, 10)}` };
    case "local_server.serve":
      return { severity: "info", message: `${who} turned ${d} serving ${t} through the gateway` };
    case "budget.warning":
      return { severity: "warn", message: `Budget ${t} is past its warning level: ${d}` };
    case "budget.exhausted":
      return { severity: "warn", message: `Budget ${t} is used up; requests it covers are refused until it ${d}` };
    case "budget.created":
    case "budget.changed":
      return { severity: "info", message: `${who} ${e.action === "budget.created" ? "created" : "changed"} budget ${t} (${d})` };
    case "budget.removed":
      return { severity: "info", message: `${who} removed budget ${t}` };
    case "grant.created":
    case "grant.changed":
      return { severity: "info", message: `${who} ${e.action === "grant.created" ? "created" : "changed"} grant ${t} (${d})` };
    case "grant.removed":
      return { severity: "warn", message: `${who} removed grant ${t}` };
    case "model.price":
      return { severity: "info", message: `${who} set the price of ${t}: ${d}` };
    default:
      return { severity: "info", message: `${who}: ${e.action}${t ? ` ${t}` : ""}${d ? ` (${d})` : ""}` };
  }
}

/**
 * @param {object} deps
 * @param {import("../access/directory.js").Directory} deps.directory
 * @param {import("better-sqlite3").Database} deps.db               sparkdash.db (remembers the last imported event)
 * @param {() => object[]} deps.orderedSnapshots
 * @param {{ getSpark: (id: string) => object, getLlmApiKey: (id: string, port: number) => string | undefined }} deps.registry
 * @param {(event: object) => void} deps.recordEvent
 * @param {ReturnType<typeof createGatewayClient>} [deps.client]
 * @param {object} [deps.energyTracker]       FleetEnergyTracker, for local energy cost
 * @param {() => object} [deps.getSettings]   Observer settings (electricity price, time zone)
 */
export function createGatewayBridge(deps) {
  const { directory, db, orderedSnapshots, registry, recordEvent } = deps;
  const client = deps.client || createGatewayClient();
  const energy = createEnergyPusher({ tracker: deps.energyTracker, orderedSnapshots, registry, getSettings: deps.getSettings || (() => ({})), client });
  let lastInventoryHash = "";
  let lastStatus = { up: false, error: "Not checked yet." };
  const timers = [];

  const setting = (key, fallback) => db.prepare("SELECT value FROM access_settings WHERE key = ?").get(key)?.value ?? fallback;
  const setSetting = (key, value) => db.prepare("INSERT INTO access_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(value));

  async function pushDirectory() {
    const people = directory.list().map((p) => ({ login: p.login, name: p.displayName, role: p.role }));
    const groups = directory.groups().map((g) => ({ name: g.name, members: g.members }));
    try {
      await client.call("PUT", "/internal/directory", { people, groups });
    } catch {
      /* the Gateway gets the snapshot on its next push once it's up */
    }
  }

  /** Local model servers the Observer sees. A server bound only to another machine's loopback can't be served. */
  function inventory() {
    const servers = [];
    for (const s of orderedSnapshots()) {
      const config = registry.getSpark(s.id) || {};
      const host = llmProbeHost(config);
      if (!host) continue;
      const loopbackElsewhere = /^(127\.|localhost$|::1$)/.test(host) && !config.isLocal;
      for (const m of s.metrics?.llm || []) {
        if (!m?.port || (!m.available && !(m.models || []).length)) continue;
        servers.push({
          machine: s.name || s.id,
          address: host,
          port: m.port,
          backend: m.backend || null,
          models: m.models?.length ? m.models : m.modelId ? [m.modelId] : [],
          apiKey: registry.getLlmApiKey(s.id, m.port) || undefined,
          up: Boolean(m.available),
          reachable: m.via !== "ssh-tunnel" && !loopbackElsewhere,
        });
      }
    }
    return servers;
  }

  async function pushInventory(force = false) {
    const servers = inventory();
    const hash = crypto.createHash("sha256").update(JSON.stringify(servers)).digest("hex");
    if (!force && hash === lastInventoryHash) return;
    try {
      await client.call("PUT", "/internal/inventory", { servers });
      lastInventoryHash = hash;
    } catch {
      /* retried on the next tick */
    }
  }

  async function importEvents() {
    let since = Number(setting("gateway_events_since", 0));
    try {
      const r = await client.call("GET", `/internal/events?since=${since}`);
      for (const e of r.body.events || []) {
        const { severity, message } = describeEvent(e);
        recordEvent({ type: `gateway.${e.action}`, severity, message });
        since = Math.max(since, e.id);
      }
      setSetting("gateway_events_since", since);
    } catch {
      /* the Gateway may be down; events wait for it */
    }
  }

  async function status() {
    try {
      const r = await client.call("GET", "/internal/health");
      lastStatus = r.status === 200 ? { up: true, ...r.body } : { up: false, error: r.body.error || `HTTP ${r.status}` };
    } catch (err) {
      lastStatus = { up: false, error: err.message };
    }
    return lastStatus;
  }

  function registerRoutes(app) {
    app.get("/api/gateway/status", async (_req, res) => {
      const [gateway, publishState] = await Promise.all([status(), publishStatus(GATEWAY_PORT)]);
      res.json({ gateway, publish: publishState, port: GATEWAY_PORT });
    });

    app.post("/api/gateway/publish", async (req, res) => {
      const out = await publish(GATEWAY_PORT);
      if (out.ok) recordEvent({ type: "gateway.published", severity: "success", message: `${req.access.label} published the AI gateway on the tailnet at ${out.url}` });
      res.status(out.ok ? 200 : 502).json(out);
    });

    // Every admin read and write goes through here to /internal/admin/*. The access guard already
    // applied the minimum role: GET needs Auditor, anything else Admin.
    app.all("/api/gateway/admin/*rest", async (req, res) => {
      const sub = req.path.slice("/api/gateway/admin".length);
      try {
        const r = await client.call(req.method, `/internal/admin${sub}`, req.method === "GET" || req.method === "DELETE" ? undefined : req.body ?? {}, req.access?.label || "sparkDash");
        if (req.method !== "GET" && r.status < 300) {
          // An admin change may have produced audit events; bring them into Activity now.
          void importEvents();
          if (sub === "/enable") void pushDirectory();
        }
        res.status(r.status).json(r.body);
      } catch (err) {
        res.status(err instanceof GatewayDown ? 503 : 500).json({ error: err.message, gatewayDown: err instanceof GatewayDown });
      }
    });
  }

  function start() {
    const every = (ms, fn) => {
      const t = setInterval(() => void fn(), ms);
      t.unref?.();
      timers.push(t);
    };
    void pushDirectory();
    void pushInventory(true);
    void importEvents();
    every(5 * 60_000, pushDirectory); // in case the Gateway restarted with an old snapshot
    every(30_000, () => pushInventory(false));
    every(30_000, importEvents);
    every(5 * 60_000, () => pushInventory(true));
    every(15_000, () => {
      energy.sample();
      return energy.push();
    });
  }

  return { registerRoutes, start, stop: () => timers.forEach(clearInterval), pushDirectory, pushInventory, importEvents, inventory, status, energy };
}
