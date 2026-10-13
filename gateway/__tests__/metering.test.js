import { test } from "node:test";
import assert from "node:assert/strict";
import { chatSse } from "./fakeUpstream.js";
import { startGateway } from "./harness.js";
import { allocateMinute } from "../usage/energy.js";

const SERVE = { "tailscale-user-login": "sam@onyx.test", "tailscale-user-name": "Sam" };
const ANTH = { "anthropic-version": "2023-06-01" };
const json = (body, extra = {}) => ({ method: "POST", headers: { "content-type": "application/json", ...SERVE, ...extra }, body: JSON.stringify(body) });
const until = async (fn, ms = 3000) => {
  for (const t0 = Date.now(); !fn() && Date.now() - t0 < ms; ) await new Promise((r) => setTimeout(r, 5));
};
const lastRow = (g) => g.gw.db.prepare("SELECT * FROM requests ORDER BY id DESC LIMIT 1").get();

async function price(g, name, p) {
  const m = (await g.admin("GET", "/models")).json().models.find((x) => x.name === name);
  const r = await g.admin("PATCH", `/models/${m.id}/prices`, p);
  assert.equal(r.status, 200, r.text);
  return r.json().model;
}

test("Anthropic stream: tokens from message_start and message_delta, costed at the price it was charged", async (t) => {
  const g = await startGateway(t);
  await g.setup();
  await price(g, "claude-test", { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 });
  const r = await g.call("/v1/messages", json({ model: "claude-test", max_tokens: 50, stream: true, messages: [] }, ANTH));
  assert.equal(r.status, 200);
  const row = lastRow(g);
  assert.equal(row.in_tok, 12);
  assert.equal(row.out_tok, 5);
  assert.equal(row.usage_state, "ok");
  assert.equal(row.partial, 0);
  assert.equal(row.cost_basis, "key");
  assert.equal(row.cost_usd, (12 * 3 + 5 * 15) / 1e6);
  assert.deepEqual(JSON.parse(row.price_snapshot), { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 });
  // A later price change doesn't rewrite what was charged.
  await price(g, "claude-test", { in: 100, out: 100 });
  assert.equal(g.gw.db.prepare("SELECT cost_usd FROM requests WHERE id = ?").get(row.id).cost_usd, row.cost_usd);
});

test("non-streaming: Anthropic cache reads, OpenAI Chat, and a gzip-encoded Responses body the client still gets compressed", async (t) => {
  const g = await startGateway(t);
  await g.setup();
  await g.call("/v1/messages", json({ model: "claude-test", max_tokens: 5, messages: [] }, ANTH));
  let row = lastRow(g);
  assert.deepEqual([row.in_tok, row.out_tok, row.cache_read_tok], [20, 10, 1000]);
  assert.equal(row.cost_usd, null, "no price set: no dollar cost");

  await g.call("/v1/chat/completions", json({ model: "gpt-test", messages: [] }));
  row = lastRow(g);
  assert.deepEqual([row.in_tok, row.out_tok], [11, 4]);

  // The provider adds the model name "gpt-gzip"; the fake answers gzip when asked.
  g.gw.db.prepare("INSERT INTO models (provider_id, name, upstream_name) SELECT provider_id, 'gpt-gzip', 'gpt-gzip' FROM models WHERE name = 'gpt-test'").run();
  const res = await fetch(`${g.base}/v1/responses`, { ...json({ model: "gpt-gzip", input: "hi" }), headers: { ...json({}).headers, "accept-encoding": "gzip" } });
  assert.equal(res.headers.get("content-encoding"), "gzip", "the client gets the provider's bytes unchanged");
  assert.equal((await res.json()).usage.input_tokens, 25);
  row = lastRow(g);
  assert.deepEqual([row.in_tok, row.out_tok, row.cache_read_tok], [20, 15, 5]);
});

test("streamed Chat Completions: include_usage is added upstream and its extra chunk never reaches the client", async (t) => {
  const g = await startGateway(t);
  await g.setup();
  const before = g.upstream.seen.length;
  const res = await fetch(`${g.base}/v1/chat/completions`, json({ model: "gpt-test", stream: true, messages: [] }));
  const text = await res.text();
  const sent = g.upstream.seen.slice(before).find((s) => s.path === "/v1/chat/completions");
  assert.deepEqual(sent.body.stream_options, { include_usage: true });
  assert.equal(sent.headers["accept-encoding"], "identity");
  const upstreamWithUsage = chatSse(true);
  assert.equal(text, [upstreamWithUsage[0], upstreamWithUsage[1], upstreamWithUsage[3]].join(""), "everything but the usage-only chunk");
  assert.ok(!text.includes('"choices":[]'));
  const row = lastRow(g);
  assert.deepEqual([row.in_tok, row.out_tok, row.cache_read_tok], [8, 6, 32]);

  // A client that asked for usage gets the chunk, untouched.
  const asked = await fetch(`${g.base}/v1/chat/completions`, json({ model: "gpt-test", stream: true, stream_options: { include_usage: true }, messages: [] }));
  assert.equal(await asked.text(), chatSse(true).join(""));

  // The provider switch turns the body change off: no usage, nothing injected.
  const openai = g.gw.providers.list().find((p) => p.type === "openai");
  await g.admin("PATCH", `/providers/${openai.id}`, { injectUsage: false });
  const b2 = g.upstream.seen.length;
  const plain = await fetch(`${g.base}/v1/chat/completions`, json({ model: "gpt-test", stream: true, messages: [] }));
  assert.equal(await plain.text(), chatSse(false).join(""));
  assert.equal(g.upstream.seen.slice(b2).find((s) => s.path === "/v1/chat/completions").body.stream_options, undefined);
  assert.equal(lastRow(g).usage_state, "none");
});

test("Gemini stream usage; a dropped Anthropic stream is stored with what was known, marked partial", async (t) => {
  const g = await startGateway(t);
  await g.setup();
  await g.call("/v1beta/models/gemini-test:streamGenerateContent?alt=sse", json({ contents: [] }));
  let row = lastRow(g);
  assert.deepEqual([row.in_tok, row.out_tok], [3, 1]);

  g.gw.db.prepare("INSERT INTO models (provider_id, name, upstream_name) SELECT provider_id, 'claude-drop', 'claude-drop' FROM models WHERE name = 'claude-test'").run();
  await fetch(`${g.base}/v1/messages`, json({ model: "claude-drop", max_tokens: 5, stream: true, messages: [] }, ANTH))
    .then((r) => r.text())
    .catch(() => {});
  await new Promise((r) => setTimeout(r, 150));
  row = lastRow(g);
  assert.equal(row.model, "claude-drop");
  assert.equal(row.partial, 1);
  assert.equal(row.usage_state, "partial");
  assert.equal(row.in_tok, 12);
});

test("count_tokens is not metered; own-login requests are Subscription with tokens and no dollars", async (t) => {
  const g = await startGateway(t);
  await g.setup();
  await price(g, "claude-test", { in: 3, out: 15 });
  await g.call("/v1/messages/count_tokens", json({ model: "claude-test", messages: [] }, ANTH));
  assert.equal(lastRow(g).usage_state, "unmetered");
  const anth = g.gw.providers.list().find((p) => p.type === "anthropic");
  await g.admin("PATCH", `/providers/${anth.id}`, { ownLogin: true });
  await g.call("/v1/messages", json({ model: "claude-test", max_tokens: 5, messages: [] }, { ...ANTH, authorization: "Bearer sk-ant-oat01-PLANTEDsubscriptionTOKEN0000000000000000" }));
  const row = lastRow(g);
  assert.equal(row.cost_basis, "subscription");
  assert.equal(row.in_tok, 20);
  assert.equal(row.cost_usd, null);
  assert.equal(row.price_snapshot, null);
});

// ─── Budgets ──────────────────────────────────────────────
test("an exhausted budget: 429 in each client's format, x-should-retry false, naming the budget and its reset", async (t) => {
  const g = await startGateway(t);
  await g.setup();
  await price(g, "claude-test", { in: 1000, out: 1000 });
  await price(g, "gpt-test", { in: 1000, out: 1000 });
  const b = await g.admin("POST", "/budgets", { name: "Sam monthly", scope: "person:sam@onyx.test", period: "month", limitUsd: 0.1 });
  assert.equal(b.status, 200, b.text);
  // 20 in + 10 out + 1000 cache read at $1000/M = $1.03: over the $0.10 limit in one go.
  assert.equal((await g.call("/v1/messages", json({ model: "claude-test", max_tokens: 50, messages: [] }, ANTH))).status, 200);
  const a = await g.call("/v1/messages", json({ model: "claude-test", max_tokens: 50, messages: [] }, ANTH));
  assert.equal(a.status, 429);
  assert.equal(a.headers.get("x-should-retry"), "false");
  assert.equal(a.headers.get("retry-after"), null);
  assert.equal(a.json().error.type, "rate_limit_error");
  assert.match(a.json().error.message, /^Budget 'Sam monthly' used: \$1\.03 of \$0\.10\. Resets [A-Z][a-z]{2} 1\.$/);
  const o = await g.call("/v1/chat/completions", json({ model: "gpt-test", messages: [] }));
  assert.equal(o.status, 429);
  assert.equal(o.json().error.type, "insufficient_quota");
  // Someone else isn't covered.
  assert.equal((await g.call("/v1/messages", json({ model: "claude-test", max_tokens: 50, messages: [] }, { ...ANTH, "tailscale-user-login": "pat@onyx.test" }))).status, 200);
  // Refusals are recorded, without tokens or cost.
  const refused = g.gw.db.prepare("SELECT status, usage_state, in_tok, cost_usd, error FROM requests WHERE usage_state = 'refused'").all();
  assert.equal(refused.length, 2);
  assert.deepEqual([refused[0].status, refused[0].in_tok, refused[0].cost_usd], [429, null, null]);
  assert.match(refused[0].error, /Sam monthly/);
  // Exhaustion is audited once, and is a finding.
  const events = g.gw.state.eventsSince(0).filter((e) => e.action === "budget.exhausted");
  assert.equal(events.length, 1);
  assert.ok((await g.admin("GET", "/status")).json().findings.some((f) => f.id.startsWith("budget-exhausted:")));
  // The Connect page shows it.
  const me = (await g.call("/me", { headers: SERVE })).json();
  assert.equal(me.budgets[0].name, "Sam monthly");
  assert.equal(me.budgets[0].state, "exhausted");
});

test("a request that could cost more than what's left is refused up front; token budgets count subscription use", async (t) => {
  const g = await startGateway(t);
  await g.setup();
  await price(g, "claude-test", { in: 1, out: 10 });
  await g.admin("POST", "/budgets", { name: "Team", scope: "everyone", period: "day", limitUsd: 1 });
  // 200,000 output tokens at $10/M could cost $2: more than the $1 budget.
  const big = await g.call("/v1/messages", json({ model: "claude-test", max_tokens: 200_000, messages: [] }, ANTH));
  assert.equal(big.status, 429);
  assert.match(big.json().error.message, /has \$1\.00 left of \$1\.00, less than this request could cost \(\$2\.00 for up to 200,000 output tokens\)/);
  assert.equal((await g.call("/v1/messages", json({ model: "claude-test", max_tokens: 1000, messages: [] }, ANTH))).status, 200);

  await g.admin("POST", "/budgets", { name: "Tokens", scope: "group:eng", period: "week", limitTokens: 1500 });
  await g.internalCall("PUT", "/internal/directory", { people: [{ login: "sam@onyx.test", role: "member" }], groups: [{ name: "eng", members: ["sam@onyx.test"] }] });
  const anth = g.gw.providers.list().find((p) => p.type === "anthropic");
  await g.admin("PATCH", `/providers/${anth.id}`, { ownLogin: true });
  const sub = { ...ANTH, authorization: "Bearer sk-ant-oat01-PLANTEDsubscriptionTOKEN0000000000000000" };
  // 1,030 tokens of subscription use, then a request that could use up to 1,000 more: refused.
  assert.equal((await g.call("/v1/messages", json({ model: "claude-test", max_tokens: 10, messages: [] }, sub))).status, 200);
  const r = await g.call("/v1/messages", json({ model: "claude-test", max_tokens: 1000, messages: [] }, sub));
  assert.equal(r.status, 429);
  assert.match(r.json().error.message, /^Budget 'Tokens' has 470 tokens left of 1,500/);
});

test("parallel requests can't overshoot: reservations hold the room, at most 8 in flight per person", async (t) => {
  const g = await startGateway(t);
  await g.setup();
  // Each request reserves 1,000 output tokens at $100/M = $0.10, and really costs
  // 20 in + 10 out + 1000 cache read at $100/M = $0.103.
  await price(g, "claude-test", { in: 100, out: 100 });
  await g.admin("POST", "/budgets", { name: "Cap", scope: "everyone", period: "month", limitUsd: 0.65 });
  let release;
  const held = new Promise((r) => (release = r));
  let arrived = 0;
  g.upstream.control.gate = () => (arrived++, held);
  const send = (login) => fetch(`${g.base}/v1/messages`, json({ model: "claude-test", max_tokens: 1000, messages: [] }, { ...ANTH, "tailscale-user-login": login })).then(async (r) => ({ status: r.status, body: await r.json() }));
  // 12 at once from one person: 6 fit the budget ($0.60 reserved), the rest are refused.
  const first = Array.from({ length: 12 }, () => send("sam@onyx.test"));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(arrived, 6, "only what the budget can cover reaches the provider");
  release();
  const results = await Promise.all(first);
  assert.equal(results.filter((r) => r.status === 200).length, 6);
  assert.equal(results.filter((r) => r.status === 429).length, 6);
  const spent = g.gw.db.prepare("SELECT sum(cost_usd) AS usd FROM requests WHERE status = 200").get().usd;
  // The overshoot is bounded by what reservations don't cover (input and cache), here 6 x $0.003.
  assert.ok(spent <= 0.65 + 6 * 0.003 + 1e-9, `spent ${spent}`);
  assert.equal((await send("sam@onyx.test")).status, 429, "used up now");

  // The concurrency cap, with a budget that has plenty of room.
  await g.admin("PATCH", "/budgets/1", { limitUsd: 1000 });
  let release2;
  const held2 = new Promise((r) => (release2 = r));
  arrived = 0;
  g.upstream.control.gate = () => (arrived++, held2);
  const burst = Array.from({ length: 10 }, () => send("pat@onyx.test"));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(arrived, 8);
  const other = send("kim@onyx.test");
  await until(() => arrived >= 9);
  assert.equal(arrived, 9, "another person isn't held up by pat's eight");
  release2();
  const out = await Promise.all([...burst, other]);
  const refused = out.filter((r) => r.status === 429);
  assert.equal(refused.length, 2);
  assert.match(refused[0].body.error.message, /already has 8 requests in progress/);
});

// ─── Local energy cost ────────────────────────────────────
test("allocation maths: token share of the minute, the rest unattributed, never more than the minute's cost", () => {
  const m = { minute: 60_000, costUsd: 0.01, serverTokens: 1000 };
  // A: 600 tokens entirely inside the minute. B: 800 tokens over two minutes, half inside.
  const { shares, gatewayTokens, attributedUsd } = allocateMinute(m, [
    { id: 1, ts: 70_000, end_ts: 80_000, tokens: 600 },
    { id: 2, ts: 90_000, end_ts: 150_000, tokens: 800 },
    { id: 3, ts: 0, end_ts: 50_000, tokens: 999 },
  ]);
  assert.equal(gatewayTokens, 600 + 400);
  assert.ok(Math.abs(shares.get(1) - 0.006) < 1e-12);
  assert.ok(Math.abs(shares.get(2) - 0.004) < 1e-12);
  assert.equal(shares.has(3), false);
  assert.ok(Math.abs(attributedUsd - 0.01) < 1e-12);
  // The Gateway saw only part of the server's tokens: the rest stays unattributed.
  const part = allocateMinute({ ...m, serverTokens: 4000 }, [{ id: 1, ts: 70_000, end_ts: 80_000, tokens: 1000 }]);
  assert.ok(Math.abs(part.attributedUsd - 0.0025) < 1e-12);
  // Sampled counters can lag: the Gateway's own count caps the share at the whole minute.
  const lag = allocateMinute({ ...m, serverTokens: 10 }, [{ id: 1, ts: 70_000, end_ts: 80_000, tokens: 1000 }]);
  assert.ok(Math.abs(lag.attributedUsd - 0.01) < 1e-12);
  // An idle minute: nothing attributed.
  assert.equal(allocateMinute(m, []).attributedUsd, 0);
});

test("a local request gets its energy cost when the Observer's minute arrives; the time zone comes with it", async (t) => {
  const g = await startGateway(t);
  await g.setup();
  await g.internalCall("PUT", "/internal/inventory", { servers: [{ machine: "Spark 1", address: "127.0.0.1", port: g.upstream.port, backend: "vllm", models: ["qwen3-coder"], apiKey: "local-key", up: true }] });
  await g.admin("PATCH", `/local-servers/${encodeURIComponent(`spark-1:${g.upstream.port}`)}`, { serve: true });
  const r = await g.call("/v1/chat/completions", json({ model: "spark-1/qwen3-coder", stream: true, messages: [] }));
  assert.equal(r.status, 200);
  let row = lastRow(g);
  assert.equal(row.cost_basis, "local");
  assert.equal(row.cost_usd, null, "not settled yet");
  assert.equal(row.in_tok + row.cache_read_tok + row.out_tok, 46);
  const minute = Math.floor(row.ts / 60_000) * 60_000;
  // Pretend the minute ended long enough ago to settle: move the request back two minutes.
  g.gw.db.prepare("UPDATE requests SET ts = ts - 120000, end_ts = end_ts - 120000 WHERE id = ?").run(row.id);
  const push = await g.internalCall("POST", "/internal/energy", {
    timeZone: "America/Toronto",
    rate: 0.2,
    minutes: [{ machine: "Spark 1", minute: minute - 120_000, wh: 5, serverTokens: 92 }],
  });
  assert.equal(push.status, 200);
  assert.equal(push.json().stored, 1);
  row = g.gw.db.prepare("SELECT * FROM requests WHERE id = ?").get(row.id);
  // 5 Wh at $0.20/kWh = $0.001 for the minute; the Gateway's 46 of the server's 92 tokens: half.
  assert.ok(Math.abs(row.cost_usd - 0.0005) < 1e-12, `cost ${row.cost_usd}`);
  const energy = (await g.admin("GET", "/usage/energy?range=24h")).json();
  assert.ok(Math.abs(energy.costUsd - 0.001) < 1e-12);
  assert.ok(Math.abs(energy.unattributedUsd - 0.0005) < 1e-12);
  assert.equal(energy.byMachine[0].machine, "spark-1");
  assert.equal(g.gw.state.timeZone, "America/Toronto");
  // Sent again: stored once, never re-costed.
  await g.internalCall("POST", "/internal/energy", { rate: 0.2, minutes: [{ machine: "Spark 1", minute: minute - 120_000, wh: 50, serverTokens: 92 }] });
  assert.ok(Math.abs(g.gw.db.prepare("SELECT cost_usd FROM requests WHERE id = ?").get(row.id).cost_usd - 0.0005) < 1e-12);
  // Token totals feed.
  const local = (await g.admin("GET", "/usage/local")).json().models;
  assert.equal(local[0].model, "spark-1/qwen3-coder");
  assert.equal(local[0].completionTokens, 6);
});

// ─── Grants editor and usage views ────────────────────────
test("grants: create, preview who gains and loses, edit, remove", async (t) => {
  const g = await startGateway(t);
  await g.setup();
  await g.internalCall("PUT", "/internal/directory", { people: [{ login: "sam@onyx.test", role: "member" }, { login: "pat@onyx.test", role: "member" }], groups: [{ name: "eng", members: ["sam@onyx.test"] }] });
  const everyone = (await g.admin("GET", "/grants")).json().grants[0];
  // Narrowing Everyone to Claude only: both lose GPT and Gemini.
  const narrow = (await g.admin("POST", "/grants/preview", { id: everyone.id, draft: { ...everyone, modelPatterns: ["claude-*"] } })).json();
  assert.deepEqual(narrow.changes.map((c) => c.caller).sort(), ["pat@onyx.test", "sam@onyx.test"]);
  assert.ok(narrow.changes[0].losses.includes("gpt-test"));
  await g.admin("PATCH", `/grants/${everyone.id}`, { modelPatterns: ["claude-*"] });
  assert.equal((await g.call("/v1/chat/completions", json({ model: "gpt-test", messages: [] }))).status, 403);
  // A grant for the eng group: only Sam gains.
  const add = (await g.admin("POST", "/grants/preview", { draft: { name: "Eng GPT", selectors: ["group:eng"], modelPatterns: ["gpt-*"] } })).json();
  assert.deepEqual(add.changes, [{ caller: "sam@onyx.test", gains: ["gpt-test"], losses: [] }]);
  const created = (await g.admin("POST", "/grants", { name: "Eng GPT", selectors: "group:eng", modelPatterns: "gpt-*" })).json().grant;
  assert.equal((await g.call("/v1/chat/completions", json({ model: "gpt-test", messages: [] }))).status, 200);
  // Bad selectors are refused with the fix.
  const bad = await g.admin("POST", "/grants", { name: "x", selectors: ["has space"], modelPatterns: ["*"] });
  assert.equal(bad.status, 400);
  assert.match(bad.json().error, /isn't a selector/);
  await g.admin("DELETE", `/grants/${created.id}`);
  assert.equal((await g.call("/v1/chat/completions", json({ model: "gpt-test", messages: [] }))).status, 403);
  assert.ok(g.gw.state.eventsSince(0).some((e) => e.action === "grant.changed"));
});

test("usage views group by person, group, model, provider, client and session", async (t) => {
  const g = await startGateway(t);
  await g.setup();
  await g.internalCall("PUT", "/internal/directory", { people: [], groups: [{ name: "eng", members: ["sam@onyx.test"] }] });
  await price(g, "claude-test", { in: 3, out: 15 });
  await g.call("/v1/messages", json({ model: "claude-test", max_tokens: 5, messages: [] }, { ...ANTH, "user-agent": "claude-cli/2.1.296 (external, cli)", "x-claude-code-session-id": "sess-1" }));
  await g.call("/v1/chat/completions", json({ model: "gpt-test", messages: [] }, { "user-agent": "opencode/1.19.0" }));
  const by = async (k) => (await g.admin("GET", `/usage?range=24h&groupBy=${k}`)).json().rows;
  assert.equal((await by("person"))[0].key, "sam@onyx.test");
  assert.equal((await by("person"))[0].requests, 2);
  assert.deepEqual((await by("group")).map((r) => [r.key, r.requests]), [["eng", 2]]);
  assert.deepEqual((await by("model")).map((r) => r.key).sort(), ["claude-test", "gpt-test"]);
  assert.deepEqual((await by("client")).map((r) => r.key).sort(), ["Claude Code", "OpenCode"]);
  assert.ok((await by("session")).some((r) => r.key === "sess-1"));
  const top = (await by("model")).find((r) => r.key === "claude-test");
  assert.ok(Math.abs(top.cloudUsd - (20 * 3 + 10 * 15 + 1000 * 3) / 1e6) < 1e-12);
  assert.equal((await by("model")).find((r) => r.key === "gpt-test").unpricedRequests, 1);
  const daily = (await g.admin("GET", "/usage/daily?range=7d")).json();
  assert.equal(daily.rows.reduce((n, r) => n + r.requests, 0), 2);
  assert.ok((await g.admin("GET", "/status")).json().findings.some((f) => f.id === "models-unpriced"));
});
