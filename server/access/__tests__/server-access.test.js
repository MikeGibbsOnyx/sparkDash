// End to end against the real server: a teammate arriving through Tailscale Serve is a
// Member and reaches no fleet route; the local console promotes them to Admin and they
// reach everything; Funnel traffic is refused; the WebSocket upgrade checks the role.
// Serve is simulated by sending its identity headers from loopback, exactly what Serve does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { isolatedConfigEnv } from "../../__tests__/isolatedEnv.js";

async function freePort() {
  const s = createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

async function startServer(t, env = {}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sparkdash-access-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const cfg = isolatedConfigEnv(tmp);
  await writeFile(cfg.SPARKS_JSON_PATH, '{"sparks":[]}\n');
  const port = await freePort();
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: path.resolve(import.meta.dirname, "../../.."),
    env: {
      ...process.env,
      ...cfg,
      BIND_HOST: "127.0.0.1",
      PORT: String(port),
      SPARKDASH_TOKEN: "",
      SPARKDASH_LOCAL_CONSOLE: "",
      // No tailscaled in tests: whois must fail closed, not reach a real daemon.
      TAILSCALED_SOCKET: path.join(tmp, "no-tailscaled.sock"),
      PATH: "/nonexistent",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));
  let output = "";
  child.stdout.on("data", (c) => (output += c));
  child.stderr.on("data", (c) => (output += c));
  await Promise.race([
    new Promise((resolve) => {
      const check = () => (output.includes("server listening") ? resolve() : setTimeout(check, 10));
      check();
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 5_000)),
  ]);
  return { base: `http://127.0.0.1:${port}`, port, output: () => output };
}

const TEAMMATE = { "tailscale-user-login": "sam@onyx.test", "tailscale-user-name": "Sam" };

function wsOpens(port, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    ws.on("open", () => (ws.close(), resolve(true)));
    ws.on("error", () => resolve(false));
    ws.on("unexpected-response", () => resolve(false));
  });
}

test("Phase 1 done-when: Member through Serve, promoted to Admin by the local console", async (t) => {
  const { base, port, output } = await startServer(t);
  assert.match(output(), /No Owner yet\. .*claim code/, "remote-first installs get a claim code at startup");

  // A teammate through Serve is a Member: they learn who they are, but get no fleet data.
  const me = await (await fetch(`${base}/api/access/me`, { headers: TEAMMATE })).json();
  assert.equal(me.role, "member");
  assert.equal(me.login, "sam@onyx.test");
  for (const p of ["/api/sparks", "/api/settings", "/api/events", "/api/fleet-energy", "/api/llm-token-totals", "/api/access/people"]) {
    const r = await fetch(`${base}${p}`, { headers: TEAMMATE });
    assert.equal(r.status, 403, p);
    assert.match((await r.json()).error, /Auditor role\. You're a Member/);
  }
  const put = await fetch(`${base}/api/settings`, { method: "PUT", headers: { ...TEAMMATE, "content-type": "application/json" }, body: "{}" });
  assert.equal(put.status, 403);
  assert.equal(await wsOpens(port, TEAMMATE), false, "Members don't get the live fleet socket");
  // The SPA shell still loads so the browser can send them to the Connect page.
  assert.notEqual((await fetch(`${base}/`, { headers: TEAMMATE })).status, 403);

  // The local console still has full access, and promotes them.
  const local = await (await fetch(`${base}/api/access/me`)).json();
  assert.deepEqual([local.via, local.role], ["local", "owner"]);
  assert.equal((await fetch(`${base}/api/sparks`)).status, 200);
  assert.equal(await wsOpens(port, {}), true);
  const promote = await fetch(`${base}/api/access/people/sam@onyx.test/role`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: "admin" }) });
  assert.equal(promote.status, 200);

  // Now they see everything, and can change things, but can't make Owners.
  assert.equal((await fetch(`${base}/api/sparks`, { headers: TEAMMATE })).status, 200);
  assert.equal(await wsOpens(port, TEAMMATE), true);
  const settings = await fetch(`${base}/api/settings`, { method: "PUT", headers: { ...TEAMMATE, "content-type": "application/json" }, body: "{}" });
  assert.equal(settings.status, 200);
  const selfOwner = await fetch(`${base}/api/access/people/sam@onyx.test/role`, { method: "PUT", headers: { ...TEAMMATE, "content-type": "application/json" }, body: JSON.stringify({ role: "owner" }) });
  assert.equal(selfOwner.status, 403);
  const code = await fetch(`${base}/api/access/claim-codes`, { method: "POST", headers: TEAMMATE });
  assert.equal(code.status, 403, "claim codes are Owner-only");

  // The change is in Activity.
  const events = await (await fetch(`${base}/api/events`)).json();
  assert.ok(events.events.some((e) => e.type === "access.person.role" && /Sam from Member to Admin/.test(e.message)));
});

test("Funnel and unidentified forwarders are refused on every route with the fix", async (t) => {
  const { base, port } = await startServer(t);
  const funnel = { "x-forwarded-for": "203.0.113.9" };
  for (const p of ["/api/sparks", "/api/access/people"]) {
    const r = await fetch(`${base}${p}`, { headers: funnel });
    assert.equal(r.status, 401, p);
    const body = await r.json();
    assert.match(body.error, /203\.0\.113\.9/);
    assert.match(body.fix, /Tailscale Serve|SPARKDASH_TOKEN/);
  }
  const me = await (await fetch(`${base}/api/access/me`, { headers: { ...funnel, ...TEAMMATE } })).json();
  assert.equal(me.signedIn, false, "a login header next to a public forwarded IP is not trusted");
  assert.equal(await wsOpens(port, funnel), false);
});

test("SPARKDASH_LOCAL_CONSOLE=0 refuses the local console; SPARKDASH_TOKEN still acts as Admin", async (t) => {
  const { base } = await startServer(t, { SPARKDASH_LOCAL_CONSOLE: "0", SPARKDASH_TOKEN: "test-token-123" });
  const r = await fetch(`${base}/api/sparks`);
  assert.equal(r.status, 401);
  assert.match((await r.json()).error, /SPARKDASH_LOCAL_CONSOLE=0/);
  const auth = { authorization: "Bearer test-token-123" };
  assert.equal((await fetch(`${base}/api/sparks`, { headers: auth })).status, 200);
  const me = await (await fetch(`${base}/api/access/me`, { headers: auth })).json();
  assert.deepEqual([me.via, me.role], ["token", "admin"]);
  assert.equal((await fetch(`${base}/api/access/claim-codes`, { method: "POST", headers: auth })).status, 403, "the token is Admin, not Owner");
});

test("with SPARKDASH_TOKEN set, the local console reads freely and needs the token to change things (as before)", async (t) => {
  const { base } = await startServer(t, { SPARKDASH_TOKEN: "test-token-456" });
  assert.equal((await fetch(`${base}/api/sparks`)).status, 200);
  assert.equal((await fetch(`${base}/api/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" })).status, 403);
  const ok = await fetch(`${base}/api/settings`, { method: "PUT", headers: { "content-type": "application/json", authorization: "Bearer test-token-456" }, body: "{}" });
  assert.equal(ok.status, 200);
});

test("no secret in any response or log: SPARKDASH_TOKEN and claim codes stay out of everything but their one place", async (t) => {
  const TOKEN = "PLANTED-token-7f3c9a1e";
  const { base, output } = await startServer(t, { SPARKDASH_TOKEN: TOKEN });
  const auth = { authorization: `Bearer ${TOKEN}` };
  const seen = [];
  const hit = async (p, init = {}) => {
    const r = await fetch(`${base}${p}`, init);
    seen.push(`${p} ${r.status} ${JSON.stringify([...r.headers])} ${await r.text()}`);
  };
  const json = (body) => ({ "content-type": "application/json", ...auth, ...body });
  // Identities of every kind, success and error paths.
  for (const headers of [{}, auth, TEAMMATE, { ...TEAMMATE, ...auth }, { "x-forwarded-for": "203.0.113.9" }, { authorization: "Bearer wrong-token" }]) {
    for (const p of ["/api/access/me", "/api/access/people", "/api/access/settings", "/api/access/audit", "/api/sparks", "/api/auth/status"]) await hit(p, { headers });
  }
  await hit("/api/access/people/nobody@x.test/role", { method: "PUT", headers: json(), body: JSON.stringify({ role: "admin" }) });
  await hit("/api/access/groups", { method: "POST", headers: json(), body: JSON.stringify({ name: "bad name!", members: [TOKEN] }) });
  await hit("/api/access/claim", { method: "POST", headers: { ...TEAMMATE, "content-type": "application/json" }, body: JSON.stringify({ code: TOKEN }) });
  await hit("/api/access/settings", { method: "PUT", headers: json(), body: JSON.stringify({ defaultRole: TOKEN }) });

  const all = seen.join("\n");
  assert.equal(all.includes(TOKEN), false, "the token appears in a response");
  assert.equal(output().includes(TOKEN), false, "the token appears in the server log");

  // A claim code is shown once, at startup (by design), and never comes back from the API.
  const code = /claim code to become Owner: ([A-Z0-9-]+)/.exec(output())[1];
  assert.equal(all.includes(code), false, "a claim code appears in a response");
  assert.equal(all.includes(code.replace(/-/g, "")), false);
});

test("a claim code entered through Serve makes that person Owner, once", async (t) => {
  const { base, output } = await startServer(t);
  const code = /claim code to become Owner: ([A-Z0-9-]+)/.exec(output())[1];
  const claim = (headers) => fetch(`${base}/api/access/claim`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ code }) });
  const ownerToBe = { "tailscale-user-login": "owner@onyx.test" };
  assert.equal((await claim(ownerToBe)).status, 200);
  assert.equal((await (await fetch(`${base}/api/access/me`, { headers: ownerToBe })).json()).role, "owner");
  assert.equal((await claim(TEAMMATE)).status, 400, "single use");
  assert.equal((await (await fetch(`${base}/api/access/me`, { headers: TEAMMATE })).json()).role, "member");
});
