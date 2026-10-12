import { test } from "node:test";
import assert from "node:assert/strict";
import { ANTHROPIC_SSE } from "./fakeUpstream.js";
import { KEYS, startGateway } from "./harness.js";

const SERVE = { "tailscale-user-login": "sam@onyx.test", "tailscale-user-name": "Sam" };
const json = (body, extra = {}) => ({ method: "POST", headers: { "content-type": "application/json", ...SERVE, ...extra }, body: JSON.stringify(body) });

test("turned off: every format gets a 503 in its own shape", async (t) => {
  const g = await startGateway(t);
  const a = await g.call("/v1/messages", json({ model: "claude-test", max_tokens: 5, messages: [] }, { "anthropic-version": "2023-06-01" }));
  assert.equal(a.status, 503);
  assert.equal(a.json().type, "error");
  const o = await g.call("/v1/chat/completions", json({ model: "gpt-test", messages: [] }));
  assert.equal(o.status, 503);
  assert.ok(o.json().error.message.includes("turned off"));
});

test("streams Anthropic SSE byte for byte, pings included, one event at a time", async (t) => {
  const g = await startGateway(t);
  await g.setup();
  const upstreamText = ANTHROPIC_SSE.join("");
  let received = "";
  const arrived = [];
  // The upstream won't send event i until the client has the bytes of event i-1:
  // a buffering proxy would deadlock here and the test would time out.
  g.upstream.control.gate = (i) =>
    new Promise((resolve) => {
      const want = ANTHROPIC_SSE.slice(0, i).join("");
      const check = () => (received.startsWith(want) ? resolve() : setTimeout(check, 2));
      check();
    });
  const res = await fetch(`${g.base}/v1/messages`, json({ model: "claude-test", max_tokens: 5, stream: true, messages: [{ role: "user", content: "hi" }] }, { "anthropic-version": "2023-06-01" }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  assert.equal(res.headers.get("request-id"), "req_fake_1");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += dec.decode(value, { stream: true });
    arrived.push(received.length);
  }
  assert.equal(received, upstreamText, "byte-identical");
  assert.equal((received.match(/event: ping/g) || []).length, 2, "SSE pings kept");
  assert.ok(arrived.length >= ANTHROPIC_SSE.length - 1, "delivered incrementally, not in one piece");
});

test("header policy: provider auth set; identity, cookies and client auth stripped; anthropic-* forwarded unchanged", async (t) => {
  const g = await startGateway(t);
  await g.setup();
  const before = g.upstream.seen.length;
  const r = await g.call(
    "/v1/messages",
    json(
      { model: "claude-test", max_tokens: 5, messages: [] },
      {
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "interleaved-thinking-2025-05-14,some-future-beta-2027-01-01",
        authorization: "Bearer sparkdash",
        cookie: "session=abc",
        "x-forwarded-for": "100.65.30.25",
        "x-sparkdash-key": "sparkdash",
        "x-claude-code-session-id": "sess-123",
        "x-claude-code-agent-id": "agent-9",
        "x-custom-thing": "keep-me",
      }
    )
  );
  assert.equal(r.status, 200);
  const h = g.upstream.seen.slice(before).find((s) => s.path === "/v1/messages").headers;
  assert.equal(h["x-api-key"], KEYS.anthropic);
  assert.equal(h["anthropic-beta"], "interleaved-thinking-2025-05-14,some-future-beta-2027-01-01");
  assert.equal(h["anthropic-version"], "2023-06-01");
  assert.equal(h["x-custom-thing"], "keep-me");
  for (const gone of ["authorization", "cookie", "x-forwarded-for", "x-sparkdash-key", "x-claude-code-session-id", "x-claude-code-agent-id", "tailscale-user-login", "tailscale-user-name"]) {
    assert.equal(h[gone], undefined, `${gone} must not reach the provider`);
  }
  const row = g.gw.db.prepare("SELECT * FROM requests ORDER BY id DESC LIMIT 1").get();
  assert.equal(row.identity, "sam@onyx.test");
  assert.equal(row.session_id, "sess-123");
  assert.equal(row.agent_id, "agent-9");
});

test("upstream errors come back unmodified: status, body, retry-after, x-should-retry, rate-limit headers", async (t) => {
  const g = await startGateway(t);
  await g.setup();
  g.gw.providers.syncModels(g.gw.providers.list().find((p) => p.type === "anthropic").id, ["claude-test", "claude-other", "claude-rate-limited"]);
  const r = await g.call("/v1/messages", json({ model: "claude-rate-limited", max_tokens: 5, messages: [] }, { "anthropic-version": "2023-06-01" }));
  assert.equal(r.status, 429);
  assert.equal(r.headers.get("retry-after"), "17");
  assert.equal(r.headers.get("x-should-retry"), "true");
  assert.equal(r.headers.get("anthropic-ratelimit-unified-status"), "rejected");
  assert.equal(r.headers.get("anthropic-ratelimit-unified-reset"), "1791800000");
  assert.deepEqual(r.json(), { type: "error", error: { type: "rate_limit_error", message: "slow down" } });
});

test("a mid-stream drop reaches the client as a broken stream and is logged as partial", async (t) => {
  const g = await startGateway(t);
  await g.setup();
  g.gw.providers.syncModels(g.gw.providers.list().find((p) => p.type === "anthropic").id, ["claude-test", "claude-drop"]);
  const res = await fetch(`${g.base}/v1/messages`, json({ model: "claude-drop", max_tokens: 5, stream: true, messages: [] }, { "anthropic-version": "2023-06-01" }));
  assert.equal(res.status, 200);
  let got = "";
  let failed = false;
  try {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += dec.decode(value, { stream: true });
    }
  } catch {
    failed = true;
  }
  assert.equal(got, ANTHROPIC_SSE.slice(0, 3).join(""), "the client has everything sent before the drop");
  assert.ok(failed || !got.includes("message_stop"), "the stream did not end cleanly");
  await new Promise((r) => setTimeout(r, 50));
  const row = g.gw.db.prepare("SELECT partial, error FROM requests ORDER BY id DESC LIMIT 1").get();
  assert.equal(row.partial, 1);
});

test("OpenAI formats and Gemini route to their providers with the right auth; query strings survive, ?key= doesn't", async (t) => {
  const g = await startGateway(t);
  await g.setup();
  for (const [p, body] of [
    ["/v1/chat/completions", { model: "gpt-test", messages: [] }],
    ["/v1/responses", { model: "gpt-test", input: "hi" }],
    ["/v1/completions", { model: "gpt-test", prompt: "hi" }],
    ["/v1/embeddings", { model: "text-embedding-test", input: "hi" }],
  ]) {
    const before = g.upstream.seen.length;
    const r = await g.call(p, json(body, { authorization: "Bearer sparkdash" }));
    assert.equal(r.status, 200, p);
    const s = g.upstream.seen.slice(before).find((x) => x.path === p);
    assert.equal(s.headers.authorization, `Bearer ${KEYS.openai}`, p);
  }
  const before = g.upstream.seen.length;
  const gm = await fetch(`${g.base}/v1beta/models/gemini-test:streamGenerateContent?alt=sse&key=sparkdash`, json({ contents: [] }, { "x-goog-api-key": "sparkdash" }));
  assert.equal(gm.status, 200);
  assert.match(await gm.text(), /usageMetadata/);
  const s = g.upstream.seen.slice(before).find((x) => x.path.includes(":streamGenerateContent"));
  assert.equal(s.headers["x-goog-api-key"], KEYS.gemini);
  assert.equal(s.search, "?alt=sse");
});

test("unknown, wrong-format and ungranted models are refused in the client's format, without retry", async (t) => {
  const g = await startGateway(t);
  await g.setup();
  const a = await g.call("/v1/messages", json({ model: "claude-nope", max_tokens: 5, messages: [] }, { "anthropic-version": "2023-06-01" }));
  assert.equal(a.status, 404);
  assert.equal(a.json().error.type, "not_found_error");
  assert.equal(a.headers.get("x-should-retry"), "false");
  const wrong = await g.call("/v1/chat/completions", json({ model: "claude-test", messages: [] }));
  assert.equal(wrong.status, 404);
  assert.match(wrong.json().error.message, /doesn't speak this API format/);
  const gm = await g.call("/v1beta/models/gemini-nope:generateContent", json({ contents: [] }));
  assert.equal(gm.status, 404);
  assert.equal(gm.json().error.status, "NOT_FOUND");

  // Narrow access: only claude-* for sam; nobody else.
  g.gw.db.prepare("UPDATE grants SET selectors = ?, model_patterns = ? WHERE name = 'Everyone'").run(JSON.stringify(["sam@onyx.test"]), JSON.stringify(["claude-*"]));
  assert.equal((await g.call("/v1/messages", json({ model: "claude-test", max_tokens: 5, messages: [] }, { "anthropic-version": "2023-06-01" }))).status, 200);
  const denied = await g.call("/v1/chat/completions", json({ model: "gpt-test", messages: [] }));
  assert.equal(denied.status, 403);
  assert.match(denied.json().error.message, /gpt-test/);
  const other = await g.call("/v1/messages", json({ model: "claude-test", max_tokens: 5, messages: [] }, { "tailscale-user-login": "pat@onyx.test", "anthropic-version": "2023-06-01" }));
  assert.equal(other.status, 403);
});

test("/v1/models answers in the caller's shape with only granted models; /v1beta/models for Gemini; HEAD /api/hello", async (t) => {
  const g = await startGateway(t);
  await g.setup();
  const openai = (await g.call("/v1/models", { headers: SERVE })).json();
  assert.equal(openai.object, "list");
  assert.ok(openai.data.some((m) => m.id === "gpt-test") && openai.data.some((m) => m.id === "claude-test"));
  const anth = (await g.call("/v1/models", { headers: { ...SERVE, "anthropic-version": "2023-06-01" } })).json();
  assert.deepEqual(anth.data.map((m) => m.id).sort(), ["claude-other", "claude-test"]);
  assert.equal(anth.data[0].type, "model");
  assert.equal(anth.has_more, false);
  const gem = (await g.call("/v1beta/models", { headers: SERVE })).json();
  assert.deepEqual(gem.models.map((m) => m.name), ["models/gemini-test"]);
  const hello = await fetch(`${g.base}/api/hello`, { method: "HEAD" });
  assert.equal(hello.status, 200);
});

test("cross-origin browsers are refused and CORS preflights are never answered", async (t) => {
  const g = await startGateway(t);
  await g.setup();
  const r = await g.call("/v1/chat/completions", json({ model: "gpt-test", messages: [] }, { origin: "https://evil.example" }));
  assert.equal(r.status, 403);
  const me = await g.call("/me", { headers: { ...SERVE, origin: "https://evil.example" } });
  assert.equal(me.status, 403);
  const pre = await fetch(`${g.base}/v1/messages`, { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
  assert.equal(pre.status, 405);
  assert.equal(pre.headers.get("access-control-allow-origin"), null);
  const same = await g.call("/me", { headers: { ...SERVE, origin: g.base } });
  assert.equal(same.status, 200);
});

test("gateway keys: shown once, work as x-api-key, stop on the next request after revoke", async (t) => {
  const g = await startGateway(t);
  await g.setup();
  const created = (await g.admin("POST", "/keys", { name: "ci-deploy", expiry: "30" })).json();
  assert.match(created.key, /^sdgw_[0-9A-Za-z]{32}$/);
  const list = (await g.admin("GET", "/keys")).json().keys;
  assert.ok(!JSON.stringify(list).includes(created.key), "the list never contains the key");
  assert.equal(list[0].prefix, created.key.slice(0, 12));
  // A CI runner: no Tailscale identity headers, key in x-api-key.
  const ok = await g.call("/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": created.key, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: "claude-test", max_tokens: 5, messages: [] }) });
  assert.equal(ok.status, 200);
  assert.equal(g.gw.db.prepare("SELECT identity FROM requests ORDER BY id DESC LIMIT 1").get().identity, "key:ci-deploy");
  await g.admin("DELETE", `/keys/${created.record.id}`);
  const after = await g.call("/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": created.key, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: "claude-test", max_tokens: 5, messages: [] }) });
  assert.equal(after.status, 401);
  assert.match(after.json().error.message, /revoked/);
  const bogus = await g.call("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer sdgw_nope" }, body: JSON.stringify({ model: "gpt-test", messages: [] }) });
  assert.equal(bogus.status, 401);
});

test("own login: forwarded only when the provider's switch is on; otherwise stripped for the company key", async (t) => {
  const g = await startGateway(t);
  await g.setup();
  const anth = g.gw.providers.list().find((p) => p.type === "anthropic");
  const oauth = "sk-ant-oat01-PLANTEDsubscriptionTOKEN000000000000000000000000000000";
  const send = () => g.call("/v1/messages", json({ model: "claude-test", max_tokens: 5, messages: [] }, { "anthropic-version": "2023-06-01", authorization: `Bearer ${oauth}`, "anthropic-beta": "oauth-2025-04-20" }));
  let before = g.upstream.seen.length;
  await send();
  let h = g.upstream.seen.slice(before).find((s) => s.path === "/v1/messages").headers;
  assert.equal(h.authorization, undefined, "off: the person's login is stripped");
  assert.equal(h["x-api-key"], KEYS.anthropic);
  await g.admin("PATCH", `/providers/${anth.id}`, { ownLogin: true });
  before = g.upstream.seen.length;
  await send();
  h = g.upstream.seen.slice(before).find((s) => s.path === "/v1/messages").headers;
  assert.equal(h.authorization, `Bearer ${oauth}`, "on: forwarded as-is");
  assert.equal(h["x-api-key"], undefined, "and the company key is not added");
  assert.equal(g.gw.db.prepare("SELECT cost_basis FROM requests ORDER BY id DESC LIMIT 1").get().cost_basis, "subscription");
});

test("local servers from the inventory: <machine>/<model>, the model name rewritten for the server, its key reused", async (t) => {
  const g = await startGateway(t);
  await g.setup();
  const push = await g.internalCall("PUT", "/internal/inventory", {
    servers: [
      { machine: "Spark 1", address: "127.0.0.1", port: g.upstream.port, backend: "vllm", models: ["qwen3-coder"], apiKey: "local-key", up: true },
      { machine: "spark-2", address: "127.0.0.1", port: 9, backend: "llama.cpp", models: ["x"], reachable: false },
    ],
  });
  assert.equal(push.status, 200);
  const servers = (await g.admin("GET", "/local-servers")).json().servers;
  assert.deepEqual(servers.map((s) => s.id), ["spark-1:" + g.upstream.port, "spark-2:9"]);
  assert.match(servers[1].fix, /LAN or tailnet address/);
  assert.equal((await g.admin("PATCH", `/local-servers/${encodeURIComponent("spark-2:9")}`, { serve: true })).status, 409);
  await g.admin("PATCH", `/local-servers/${encodeURIComponent(servers[0].id)}`, { serve: true });
  const before = g.upstream.seen.length;
  const r = await g.call("/v1/chat/completions", json({ model: "spark-1/qwen3-coder", messages: [{ role: "user", content: "hi" }] }));
  assert.equal(r.status, 200);
  const s = g.upstream.seen.slice(before).find((x) => x.path === "/v1/chat/completions");
  assert.equal(s.body.model, "qwen3-coder");
  assert.deepEqual(s.body.messages, [{ role: "user", content: "hi" }]);
  assert.equal(s.headers.authorization, "Bearer local-key");
});

test("a model offered by two providers is a config error, never resolved silently", async (t) => {
  const g = await startGateway(t);
  await g.setup();
  const second = (await g.admin("POST", "/providers", { type: "anthropic", key: KEYS.anthropic, baseUrl: g.upstream.url, name: "Anthropic (team 2)" })).json();
  assert.equal(second.saved, true);
  const r = await g.call("/v1/messages", json({ model: "claude-test", max_tokens: 5, messages: [] }, { "anthropic-version": "2023-06-01" }));
  assert.equal(r.status, 409);
  assert.match(r.json().error.message, /more than one provider/);
  assert.ok((await g.admin("GET", "/status")).json().findings.some((f) => f.id === "model-conflict:claude-test"));
});

test("a request over the body cap gets a 413 in the client's format", async (t) => {
  const g = await startGateway(t, { env: { GATEWAY_MAX_BODY_MB: "1" } });
  await g.setup();
  const big = "x".repeat(1024 * 1024 + 10);
  const r = await g.call("/v1/messages", json({ model: "claude-test", max_tokens: 5, messages: [{ role: "user", content: big }] }, { "anthropic-version": "2023-06-01" }));
  assert.equal(r.status, 413);
  assert.equal(r.json().error.type, "request_too_large");
});
