import { test } from "node:test";
import assert from "node:assert/strict";
import { startFakeMcp } from "./fakeMcp.js";
import { startGateway } from "./harness.js";
import { nameFromUrl } from "../mcp/servers.js";
import { splitToolName } from "../mcp/endpoint.js";

const TOKEN = "Bearer mcp-PLANTEDupstreamCREDENTIAL0000000000";
const as = (login) => ({ "content-type": "application/json", "tailscale-user-login": login, "user-agent": "claude-code/2.1.300" });
let nextId = 1;

async function rpc(g, login, method, params) {
  const r = await g.call("/mcp", { method: "POST", headers: as(login), body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }) });
  return r.status === 202 ? { status: 202 } : { status: r.status, ...r.json() };
}

async function withServers(t) {
  const alpha = await startFakeMcp({ auth: TOKEN });
  const beta = await startFakeMcp({ sse: true, tools: ["search"] });
  t.after(() => alpha.close());
  t.after(() => beta.close());
  const g = await startGateway(t);
  await g.setup();
  return { g, alpha, beta };
}

test("names: server from URL, tool names split at the first __", () => {
  assert.equal(nameFromUrl("https://mcp.github.com/mcp"), "github");
  assert.equal(nameFromUrl("http://10.0.0.5:9000/"), "10");
  assert.deepEqual(splitToolName("github__create_issue"), { server: "github", tool: "create_issue" });
  assert.deepEqual(splitToolName("a__b__c"), { server: "a", tool: "b__c" });
  assert.equal(splitToolName("plain"), null);
});

test("Test and save: a wrong credential names the problem and saves nothing; the right one connects; the value is write-only", async (t) => {
  const { g, alpha } = await withServers(t);
  const bad = (await g.admin("POST", "/mcp-servers", { name: "alpha", url: alpha.url, headerName: "Authorization", headerValue: "Bearer wrong" })).json();
  assert.equal(bad.saved, false);
  assert.match(bad.message, /refused the Gateway's credential \(401\)/);
  const ok = (await g.admin("POST", "/mcp-servers", { name: "alpha", url: alpha.url, headerName: "Authorization", headerValue: TOKEN })).json();
  assert.equal(ok.saved, true);
  assert.equal(ok.message, "Connected. 3 tools.");
  assert.deepEqual(ok.server.tools, ["echo", "add", "fail"]);
  assert.equal(ok.server.headerLast4, TOKEN.slice(-4));
  const listed = (await g.admin("GET", "/mcp-servers")).text;
  assert.ok(!listed.includes(TOKEN), "the credential is never returned");
  assert.equal((await g.admin("POST", "/mcp-servers", { name: "alpha", url: alpha.url })).status, 409, "names are unique");
  assert.equal((await g.admin("POST", "/mcp-servers", { name: "Bad Name", url: alpha.url })).status, 400);
  // Saving an unreachable server is allowed when asked, and is a finding.
  const down = (await g.admin("POST", "/mcp-servers", { name: "down", url: "http://127.0.0.1:9/mcp", saveAnyway: true })).json();
  assert.equal(down.saved, true);
  assert.equal(down.server.status, "Failing");
  assert.ok((await g.admin("GET", "/status")).json().findings.some((f) => f.id === `mcp-failing:${down.server.id}`));
});

test("one endpoint, different tool lists: each person sees only what their grants allow, and calls are checked", async (t) => {
  const { g, alpha, beta } = await withServers(t);
  await g.admin("POST", "/mcp-servers", { name: "alpha", url: alpha.url, headerValue: TOKEN });
  await g.admin("POST", "/mcp-servers", { name: "beta", url: beta.url });
  await g.internalCall("PUT", "/internal/directory", { people: [{ login: "sam@onyx.test", role: "member" }, { login: "pat@onyx.test", role: "member" }], groups: [{ name: "eng", members: ["sam@onyx.test"] }] });
  // Everyone keeps the models but no MCP tools; eng gets all of alpha and beta; Pat gets alpha's echo.
  const everyone = (await g.admin("GET", "/grants")).json().grants[0];
  await g.admin("PATCH", `/grants/${everyone.id}`, { mcpPatterns: [] });
  await g.admin("POST", "/grants", { name: "Eng tools", selectors: ["group:eng"], modelPatterns: [], mcpPatterns: ["alpha__*", "beta__*"] });
  await g.admin("POST", "/grants", { name: "Pat echo", selectors: ["pat@onyx.test"], modelPatterns: [], mcpPatterns: ["alpha__echo"] });

  const init = await rpc(g, "sam@onyx.test", "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });

  const sam = (await rpc(g, "sam@onyx.test", "tools/list", {})).result.tools.map((x) => x.name);
  const pat = (await rpc(g, "pat@onyx.test", "tools/list", {})).result.tools.map((x) => x.name);
  const kim = (await rpc(g, "kim@onyx.test", "tools/list", {})).result.tools.map((x) => x.name);
  assert.deepEqual(sam, ["alpha__echo", "alpha__add", "alpha__fail", "beta__search"]);
  assert.deepEqual(pat, ["alpha__echo"]);
  assert.deepEqual(kim, []);

  // Calls: through (JSON upstream and SSE upstream), the prefix stripped upstream.
  const echo = await rpc(g, "pat@onyx.test", "tools/call", { name: "alpha__echo", arguments: { text: "hi" } });
  assert.deepEqual(echo.result, { content: [{ type: "text", text: "echo: hi" }] });
  assert.equal(alpha.seen.at(-1).msg.params.name, "echo");
  assert.equal(alpha.seen.at(-1).headers.authorization, TOKEN, "the shared credential is added upstream");
  const search = await rpc(g, "sam@onyx.test", "tools/call", { name: "beta__search", arguments: { text: "x" } });
  assert.equal(search.result.content[0].text, "echo: x");
  // Ungranted: a JSON-RPC error naming the access needed; nothing reaches the server.
  const before = alpha.seen.length;
  const denied = await rpc(g, "pat@onyx.test", "tools/call", { name: "alpha__add", arguments: { a: 1, b: 2 } });
  assert.equal(denied.error.code, -32602);
  assert.match(denied.error.message, /You don't have access to alpha__add.*Access tab/);
  assert.equal(alpha.seen.length, before);
  const unknown = await rpc(g, "sam@onyx.test", "tools/call", { name: "alpha__nope" });
  assert.match(unknown.error.message, /no tool alpha__nope/);
  // Upstream errors pass through.
  const fail = await rpc(g, "sam@onyx.test", "tools/call", { name: "alpha__fail" });
  assert.deepEqual(fail.error, { code: -32010, message: "the fail tool always fails" });

  // Every call is a request record: person, server, tool, latency, status.
  const rows = g.gw.db.prepare("SELECT identity, provider_id, model, format, status, latency_ms, error FROM requests WHERE format = 'mcp' ORDER BY id").all();
  assert.deepEqual(rows.map((r) => [r.identity, r.model, r.status]), [
    ["pat@onyx.test", "alpha__echo", 200],
    ["sam@onyx.test", "beta__search", 200],
    ["pat@onyx.test", "alpha__add", 403],
    ["sam@onyx.test", "alpha__nope", 403],
    ["sam@onyx.test", "alpha__fail", 200],
  ]);
  assert.ok(rows[0].provider_id.startsWith("mcp-"));
  assert.equal(g.gw.db.prepare("SELECT client FROM requests WHERE format = 'mcp' LIMIT 1").get().client, "Claude Code");
  assert.match(rows[4].error, /always fails/);
});

test("an expired upstream session is re-made once, and the call goes through", async (t) => {
  const { g, alpha } = await withServers(t);
  await g.admin("POST", "/mcp-servers", { name: "alpha", url: alpha.url, headerValue: TOKEN });
  assert.equal((await rpc(g, "sam@onyx.test", "tools/call", { name: "alpha__echo", arguments: { text: "1" } })).result.content[0].text, "echo: 1");
  const inits = alpha.stats.initializes;
  alpha.expireSessions();
  assert.equal((await rpc(g, "sam@onyx.test", "tools/call", { name: "alpha__echo", arguments: { text: "2" } })).result.content[0].text, "echo: 2");
  assert.equal(alpha.stats.initializes, inits + 1);
  // The new session carries the protocol version the server agreed.
  assert.equal(alpha.seen.at(-1).headers["mcp-protocol-version"], "2025-06-18");
});

test("protocol: notifications get 202, GET is 405, batches, ping, unknown methods, and the gateway switched off", async (t) => {
  const { g } = await withServers(t);
  const n = await g.call("/mcp", { method: "POST", headers: as("sam@onyx.test"), body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  assert.equal(n.status, 202);
  assert.equal(n.text, "");
  const get = await g.call("/mcp", { headers: as("sam@onyx.test") });
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST");
  const batch = await g.call("/mcp", { method: "POST", headers: as("sam@onyx.test"), body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", method: "notifications/x" }, { jsonrpc: "2.0", id: 2, method: "resources/list" }]) });
  assert.deepEqual(batch.json(), [{ jsonrpc: "2.0", id: 1, result: {} }, { jsonrpc: "2.0", id: 2, error: { code: -32601, message: "The gateway doesn't serve resources/list; it offers tools only." } }]);
  assert.equal((await g.call("/mcp", { method: "POST", headers: as("sam@onyx.test"), body: "{nope" })).json().error.code, -32700);
  // Cross-origin browsers are refused, like the model APIs.
  assert.equal((await g.call("/mcp", { method: "POST", headers: { ...as("sam@onyx.test"), origin: "https://evil.example" }, body: "{}" })).status, 403);
  await g.admin("POST", "/pause");
  assert.match((await rpc(g, "sam@onyx.test", "tools/list", {})).error.message, /turned off/);
});

test("logging: arguments and results only under full capture; the upstream credential is never written anywhere", async (t) => {
  const { g, alpha } = await withServers(t);
  await g.admin("POST", "/mcp-servers", { name: "alpha", url: alpha.url, headerValue: TOKEN });
  await rpc(g, "sam@onyx.test", "tools/call", { name: "alpha__echo", arguments: { text: "metadata only" } });
  assert.equal(g.gw.db.prepare("SELECT body_path FROM requests ORDER BY id DESC LIMIT 1").get().body_path, null);
  await g.admin("PATCH", "/privacy/capture", { mode: "full" });
  await rpc(g, "sam@onyx.test", "tools/call", { name: "alpha__echo", arguments: { text: "captured" } });
  const row = g.gw.db.prepare("SELECT id FROM requests ORDER BY id DESC LIMIT 1").get();
  const content = (await g.admin("GET", `/requests/${row.id}/content`)).json().content;
  assert.deepEqual(JSON.parse(content.request), { name: "alpha__echo", arguments: { text: "captured" } });
  assert.equal(JSON.parse(content.response).content[0].text, "echo: captured");
  const everything = [...g.seenResponses, ...g.logs, JSON.stringify(g.gw.db.prepare("SELECT * FROM requests").all()), JSON.stringify(g.gw.db.prepare("SELECT * FROM audit").all()), JSON.stringify(g.gw.db.prepare("SELECT * FROM mcp_servers").all())].join("\n");
  assert.ok(!everything.includes(TOKEN.slice(7)), "the MCP credential appears nowhere");
});
