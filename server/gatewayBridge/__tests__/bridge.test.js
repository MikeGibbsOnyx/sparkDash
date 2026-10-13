import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { openAccessDb } from "../../access/db.js";
import { Directory } from "../../access/directory.js";
import { createGatewayBridge, describeEvent } from "../index.js";
import { parseServeStatus } from "../publish.js";
import { isolatedConfigEnv } from "../../__tests__/isolatedEnv.js";

function fakeClient() {
  const calls = [];
  let events = [];
  return {
    calls,
    setEvents: (e) => (events = e),
    call: async (method, p, body, actor) => {
      calls.push({ method, p, body, actor });
      if (p.startsWith("/internal/events")) {
        const since = Number(new URL(p, "http://x").searchParams.get("since"));
        return { status: 200, body: { events: events.filter((e) => e.id > since) } };
      }
      return { status: 200, body: { ok: true } };
    },
  };
}

function snapshots() {
  return [
    { id: "a", name: "Spark 1", metrics: { llm: [{ port: 8000, available: true, backend: "vllm", models: ["qwen3-coder"], via: "direct" }, { port: 8001, available: false, models: [] }] } },
    { id: "b", name: "rin-den", metrics: { llm: [{ port: 8888, available: true, backend: "llama.cpp", modelId: "gemma", via: "ssh-tunnel" }] } },
    { id: "c", name: "remote-loopback", metrics: { llm: [{ port: 9000, available: true, models: ["x"] }] } },
  ];
}
const registry = {
  getSpark: (id) => ({ a: { isLocal: true }, b: { lanIp: "10.0.0.144" }, c: { llmHost: "127.0.0.1" } })[id],
  getLlmApiKey: (id, port) => (id === "a" && port === 8000 ? "local-secret" : undefined),
};

test("inventory: what the Observer sees, with servers the Gateway can't reach marked", () => {
  const db = openAccessDb(":memory:");
  const bridge = createGatewayBridge({ directory: new Directory(db), db, orderedSnapshots: snapshots, registry, recordEvent: () => {}, client: fakeClient() });
  const inv = bridge.inventory();
  assert.deepEqual(inv.map((s) => [s.machine, s.address, s.port, s.reachable]), [
    ["Spark 1", "127.0.0.1", 8000, true],
    ["rin-den", "10.0.0.144", 8888, false],
    ["remote-loopback", "127.0.0.1", 9000, false],
  ]);
  assert.equal(inv[0].apiKey, "local-secret", "a server with a saved key reuses it");
  assert.deepEqual(inv[1].models, ["gemma"]);
});

test("events are imported into Activity once, even across restarts", async () => {
  const db = openAccessDb(":memory:");
  const recorded = [];
  const client = fakeClient();
  client.setEvents([
    { id: 1, action: "gateway.enabled", actor: "Ada", target: null, detail: "default grant created" },
    { id: 2, action: "key.revoked", actor: "Ada", target: "ci-deploy", detail: null },
  ]);
  const make = () => createGatewayBridge({ directory: new Directory(db), db, orderedSnapshots: () => [], registry, recordEvent: (e) => recorded.push(e), client });
  await make().importEvents();
  await make().importEvents();
  assert.deepEqual(recorded.map((e) => e.type), ["gateway.gateway.enabled", "gateway.key.revoked"]);
  assert.equal(recorded[1].message, "Ada revoked gateway key ci-deploy");
  assert.equal(describeEvent({ action: "key.expiring", target: "ci", detail: "2026-10-20T00:00:00Z" }).severity, "warn");
});

test("directory pushes carry people and groups, never anything else", async () => {
  const db = openAccessDb(":memory:");
  const directory = new Directory(db);
  directory.seen({ login: "sam@onyx.test", name: "Sam" });
  directory.saveGroup({ role: "admin", label: "Ada" }, { name: "Eng", members: ["sam@onyx.test", "tag:ci"] });
  const client = fakeClient();
  await createGatewayBridge({ directory, db, orderedSnapshots: () => [], registry, recordEvent: () => {}, client }).pushDirectory();
  const push = client.calls.find((c) => c.p === "/internal/directory");
  assert.deepEqual(push.body, { people: [{ login: "sam@onyx.test", name: "Sam", role: "member" }], groups: [{ name: "Eng", members: ["sam@onyx.test", "tag:ci"] }] });
});

test("tailscale serve status: published, Funnel, or the port taken by something else", () => {
  const ok = parseServeStatus({ Web: { "rin-den.tail1.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:5556" } } } } }, 5556);
  assert.deepEqual(ok, { published: true, url: "https://rin-den.tail1.ts.net:8443", funnel: false });
  const funnel = parseServeStatus({ Web: { "h.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:5556" } } } }, AllowFunnel: { "h.ts.net:8443": true } }, 5556);
  assert.equal(funnel.funnel, true);
  const other = parseServeStatus({ Web: { "h.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:18443" } } } } }, 5556);
  assert.equal(other.published, false);
  assert.match(other.conflict, /already published/);
  assert.deepEqual(parseServeStatus({}, 5556), { published: false, funnel: false });
});

// ─── End to end: the real Observer and the real Gateway, sharing an ipc dir ───
async function freePort() {
  const s = createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

function startProc(t, script, env, ready) {
  const child = spawn(process.execPath, [script], { cwd: path.resolve(import.meta.dirname, "../../.."), env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill("SIGTERM"));
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  return Promise.race([
    new Promise((resolve) => {
      const check = () => (ready.test(out) ? resolve(() => out) : setTimeout(check, 20));
      check();
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${script} did not start:\n${out}`)), 8000)),
  ]);
}

test("Observer -> Gateway: admin calls go through with roles applied; events land in Activity", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sd-bridge-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const cfg = isolatedConfigEnv(tmp);
  fs.writeFileSync(cfg.SPARKS_JSON_PATH, '{"sparks":[]}\n');
  const [obsPort, gwPort] = [await freePort(), await freePort()];
  const ipc = path.join(tmp, "ipc");
  await startProc(t, "gateway/index.js", { GATEWAY_PORT: String(gwPort), GATEWAY_DATA_DIR: path.join(tmp, "gw"), GATEWAY_IPC_DIR: ipc, TAILSCALED_SOCKET: path.join(tmp, "none.sock") }, /internal API on/);
  await startProc(t, "server/index.js", { ...cfg, GATEWAY_IPC_DIR: ipc, GATEWAY_PORT: String(gwPort), BIND_HOST: "127.0.0.1", PORT: String(obsPort), SPARKDASH_TOKEN: "", PATH: "/nonexistent" }, /server listening/);
  const base = `http://127.0.0.1:${obsPort}`;
  const member = { "tailscale-user-login": "sam@onyx.test" };
  const auditor = { "tailscale-user-login": "lee@onyx.test" };

  const status = await (await fetch(`${base}/api/gateway/status`)).json();
  assert.equal(status.gateway.up, true);
  assert.equal(status.gateway.enabled, false);

  await fetch(`${base}/api/access/me`, { headers: auditor });
  await fetch(`${base}/api/access/people/lee@onyx.test/role`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: "auditor" }) });

  assert.equal((await fetch(`${base}/api/gateway/admin/providers`, { headers: member })).status, 403, "Members don't reach the Gateway's admin API");
  assert.equal((await fetch(`${base}/api/gateway/admin/providers`, { headers: auditor })).status, 200, "Auditors read");
  assert.equal((await fetch(`${base}/api/gateway/admin/enable`, { method: "POST", headers: auditor })).status, 403, "Auditors change nothing");
  const on = await fetch(`${base}/api/gateway/admin/enable`, { method: "POST" });
  assert.equal(on.status, 200);
  assert.equal((await on.json()).enabled, true);
  const grants = await (await fetch(`${base}/api/gateway/admin/grants`)).json();
  assert.deepEqual(grants.grants.map((g) => [g.name, g.selectors, g.modelPatterns]), [["Everyone", ["*"], ["*"]]]);

  await new Promise((r) => setTimeout(r, 300));
  const events = (await (await fetch(`${base}/api/events`)).json()).events;
  assert.ok(events.some((e) => e.type === "gateway.gateway.enabled" && /local console turned on the AI gateway/.test(e.message)), JSON.stringify(events.map((e) => e.message)));

  // The Gateway itself knows the people the Observer pushed.
  const gwMe = await (await fetch(`http://127.0.0.1:${gwPort}/me`, { headers: auditor })).json();
  assert.equal(gwMe.who.role, "auditor");
});
