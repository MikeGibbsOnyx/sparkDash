import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { usageFromBody, usageFromEvent, isMetered } from "../usage/parse.js";
import { createSseReader, createUsageTap } from "../usage/tap.js";
import { createUsageChunkFilter, injectIncludeUsage } from "../usage/includeUsage.js";
import { localDay, periodBounds, resetLabel, zonedMidnight } from "../usage/periods.js";
import { costOf, priceSnapshot } from "../usage/ledger.js";
import { requestedMaxOutput, scopeMatches } from "../policy/budgets.js";

const U = (i, o, cr = null, cw = null) => ({ in: i, out: o, cacheRead: cr, cacheWrite: cw });

// ─── Parser tables per format ─────────────────────────────
test("non-streaming usage, every format, normalised so `in` never includes cached tokens", () => {
  const rows = [
    ["anthropic", { usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 40 } }, U(10, 20, 300, 40)],
    ["openai-chat", { usage: { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 64 } } }, U(36, 7, 64, null)],
    ["openai-chat", { usage: { prompt_tokens: 5, completion_tokens: 2 } }, U(5, 2, null, null)],
    ["openai-completions", { usage: { prompt_tokens: 5, completion_tokens: 2 } }, U(5, 2, null, null)],
    ["openai-embeddings", { usage: { prompt_tokens: 8, total_tokens: 8 } }, U(8, 0, null, null)],
    ["openai-responses", { usage: { input_tokens: 50, output_tokens: 9, input_tokens_details: { cached_tokens: 20 }, output_tokens_details: { reasoning_tokens: 4 } } }, U(30, 9, 20, null)],
    ["gemini", { usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 5, thoughtsTokenCount: 11, cachedContentTokenCount: 10 } }, U(20, 16, 10, null)],
    ["gemini", [{ candidates: [] }, { usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 } }], U(3, 1, null, null)],
  ];
  for (const [format, body, want] of rows) assert.deepEqual(usageFromBody(format, body), want, `${format} ${JSON.stringify(body)}`);
  assert.equal(usageFromBody("anthropic", { type: "error" }), null);
});

test("streaming usage events, every format", () => {
  assert.deepEqual(usageFromEvent("anthropic", "message_start", '{"type":"message_start","message":{"usage":{"input_tokens":12,"output_tokens":1,"cache_read_input_tokens":5}}}'), U(12, 1, 5, null));
  assert.deepEqual(usageFromEvent("anthropic", "message_delta", '{"type":"message_delta","usage":{"output_tokens":42}}'), U(null, 42, null, null));
  assert.equal(usageFromEvent("anthropic", "content_block_delta", '{"type":"content_block_delta","delta":{"text":"usage"}}'), null);
  assert.deepEqual(usageFromEvent("openai-chat", "", '{"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":3}}'), U(9, 3, null, null));
  assert.equal(usageFromEvent("openai-chat", "", '{"choices":[{"delta":{"content":"hi"}}],"usage":null}'), null);
  assert.deepEqual(usageFromEvent("openai-responses", "response.completed", '{"type":"response.completed","response":{"usage":{"input_tokens":4,"output_tokens":6}}}'), U(4, 6, null, null));
  assert.equal(usageFromEvent("openai-responses", "response.output_text.delta", '{"type":"response.output_text.delta","delta":"x"}'), null);
  assert.deepEqual(usageFromEvent("gemini", "", '{"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":1}}'), U(3, 1, null, null));
});

test("token-counting endpoints are not metered", () => {
  assert.equal(isMetered("anthropic", "/v1/messages/count_tokens"), false);
  assert.equal(isMetered("gemini", "/v1beta/models/gemini-test:countTokens"), false);
  assert.equal(isMetered("anthropic", "/v1/messages"), true);
  assert.equal(isMetered("openai-embeddings", "/v1/embeddings"), true);
});

// ─── The tap ──────────────────────────────────────────────
const SSE = { "content-type": "text/event-stream" };

async function tapAll(format, headers, chunks, complete = true) {
  const tap = createUsageTap({ format, headers });
  for (const c of chunks) tap.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return tap.end(complete);
}

test("tap: Anthropic stream takes input from message_start and output from the last message_delta", async () => {
  const r = await tapAll("anthropic", SSE, [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":12,"output_tokens":1,"cache_creation_input_tokens":100}}}\n\n',
    "event: ping\ndata: {\"type\": \"ping\"}\n\n",
    'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":5}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
  ]);
  assert.deepEqual(r.usage, U(12, 5, null, 100));
  assert.equal(r.partial, false);
});

test("tap: events split anywhere, even inside a CRLF, parse the same", async () => {
  const text = 'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":3}}\r\n\r\ndata: [DONE]\r\n\r\n';
  for (let cut = 1; cut < text.length; cut++) {
    const r = await tapAll("openai-chat", SSE, [text.slice(0, cut), text.slice(cut)]);
    assert.deepEqual(r.usage, U(9, 3, null, null), `cut at ${cut}`);
  }
});

test("tap: a stream cut short keeps the counts known so far, marked partial", async () => {
  const r = await tapAll("anthropic", SSE, ['event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":12,"output_tokens":1}}}\n\n'], false);
  assert.deepEqual(r.usage, U(12, 1, null, null));
  assert.equal(r.partial, true);
  assert.equal(r.found, true);
});

test("tap: gzip, deflate, brotli and zstd responses are read from an inflated copy", async () => {
  const body = Buffer.from(JSON.stringify({ usage: { input_tokens: 7, output_tokens: 8 } }));
  const encoders = { gzip: zlib.gzipSync, deflate: zlib.deflateSync, br: zlib.brotliCompressSync, ...(zlib.zstdCompressSync ? { zstd: zlib.zstdCompressSync } : {}) };
  for (const [enc, fn] of Object.entries(encoders)) {
    const z = fn(body);
    const r = await tapAll("anthropic", { "content-type": "application/json", "content-encoding": enc }, [z.subarray(0, 5), z.subarray(5)]);
    assert.deepEqual(r.usage, U(7, 8, null, null), enc);
  }
  const sse = zlib.gzipSync('data: {"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":1}}\r\n\r\n');
  assert.deepEqual((await tapAll("gemini", { ...SSE, "content-encoding": "gzip" }, [sse])).usage, U(3, 1, null, null));
});

test("tap: an unknown encoding or a broken compressed body is unreadable, never a crash", async () => {
  const a = await tapAll("anthropic", { "content-type": "application/json", "content-encoding": "x-weird" }, ["{}"]);
  assert.equal(a.readable, false);
  const b = await tapAll("anthropic", { "content-type": "application/json", "content-encoding": "gzip" }, ["not gzip at all"]);
  assert.equal(b.readable, false);
  assert.equal(b.found, false);
});

test("SSE reader: multi-line data, comments and a final event without a blank line", () => {
  const got = [];
  const r = createSseReader((e, d) => got.push([e, d]));
  r.push(Buffer.from(": comment\nevent: a\ndata: one\ndata: two\n\ndata: tail"));
  r.end();
  assert.deepEqual(got, [["a", "one\ntwo"], ["", "tail"]]);
});

// ─── include_usage ────────────────────────────────────────
test("include_usage is inserted as text, leaving every other byte alone", () => {
  const raw = Buffer.from('{ "model":"gpt-test",\n  "stream":true, "messages":[] }');
  const out = injectIncludeUsage(raw, JSON.parse(raw.toString()));
  assert.equal(out.toString(), '{"stream_options":{"include_usage":true}, "model":"gpt-test",\n  "stream":true, "messages":[] }');
  assert.deepEqual(JSON.parse(out.toString()).stream_options, { include_usage: true });
  // Not streaming, or the client already asked: nothing to do.
  assert.equal(injectIncludeUsage(Buffer.from('{"stream":false}'), { stream: false }), null);
  assert.equal(injectIncludeUsage(Buffer.from("{}"), { stream: true, stream_options: { include_usage: true } }), null);
  // Other stream_options are kept.
  const merged = injectIncludeUsage(Buffer.from("{}"), { stream: true, stream_options: { foo: 1, include_usage: false } });
  assert.deepEqual(JSON.parse(merged.toString()).stream_options, { foo: 1, include_usage: true });
});

test("the usage-only chunk is removed; every other event passes whole, however the bytes are split", () => {
  const events = [
    'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"Hi"}}],"usage":null}\n\n',
    'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":null}\n\n',
    'data: {"id":"c1","choices":[],"usage":{"prompt_tokens":9,"completion_tokens":3,"total_tokens":12}}\n\n',
    "data: [DONE]\n\n",
  ];
  const all = events.join("");
  const want = events[0] + events[1] + events[3];
  for (let cut = 1; cut < all.length; cut += 7) {
    const f = createUsageChunkFilter();
    const out = Buffer.concat([f.push(Buffer.from(all.slice(0, cut))), f.push(Buffer.from(all.slice(cut))), f.flush()]).toString();
    assert.equal(out, want, `cut at ${cut}`);
    assert.equal(f.dropped, 1);
  }
  // A final chunk that carries usage *and* a choice (llama.cpp style) is the client's data: kept.
  const f = createUsageChunkFilter();
  const keep = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n';
  assert.equal(f.push(Buffer.from(keep)).toString(), keep);
});

// ─── Cost ─────────────────────────────────────────────────
test("cost: tokens x the model's per-million prices; cache prices fall back to input", () => {
  const p = priceSnapshot({ price_in: 3, price_out: 15, price_cache_read: 0.3, price_cache_write: 3.75 });
  assert.equal(costOf(U(1_000_000, 100_000, 2_000_000, 0), p), 3 + 1.5 + 0.6);
  const q = priceSnapshot({ price_in: 2, price_out: 8 });
  assert.deepEqual(q, { in: 2, out: 8, cacheRead: 2, cacheWrite: 2 });
  assert.equal(priceSnapshot({ price_in: null, price_out: null }), null);
  assert.equal(costOf(U(5, 5), null), null);
});

test("requested output ceiling per format, 4,096 when absent", () => {
  assert.equal(requestedMaxOutput("anthropic", { max_tokens: 32000 }), 32000);
  assert.equal(requestedMaxOutput("openai-chat", { max_completion_tokens: 900, max_tokens: 5 }), 900);
  assert.equal(requestedMaxOutput("openai-chat", { max_tokens: 5 }), 5);
  assert.equal(requestedMaxOutput("openai-responses", { max_output_tokens: 77 }), 77);
  assert.equal(requestedMaxOutput("gemini", { generationConfig: { maxOutputTokens: 64 } }), 64);
  assert.equal(requestedMaxOutput("openai-chat", {}), 4096);
});

test("budget scopes", () => {
  const sam = { kind: "person", login: "sam@onyx.test", keyName: null, groups: ["eng"] };
  assert.ok(scopeMatches("everyone", sam));
  assert.ok(scopeMatches("person:SAM@onyx.test", sam));
  assert.ok(scopeMatches("group:Eng", sam));
  assert.ok(!scopeMatches("group:ops", sam));
  assert.ok(!scopeMatches("key:ci", sam));
  assert.ok(scopeMatches("key:ci", { kind: "key", login: null, keyName: "ci", groups: [] }));
  assert.ok(!scopeMatches("person:ci", { kind: "key", login: null, keyName: "ci", groups: [] }));
});

// ─── Periods in America/Toronto ───────────────────────────
const TZ = "America/Toronto";
const iso = (ms) => new Date(ms).toISOString();

test("periods: day, week (Monday) and month boundaries in America/Toronto, across DST", () => {
  // 2026-11-01 is the day DST ends in Toronto (EDT -4 -> EST -5).
  assert.equal(iso(zonedMidnight(2026, 11, 1, TZ)), "2026-11-01T04:00:00.000Z");
  assert.equal(iso(zonedMidnight(2026, 11, 2, TZ)), "2026-11-02T05:00:00.000Z");
  // 2026-03-08 is the day DST starts (EST -5 -> EDT -4).
  assert.equal(iso(zonedMidnight(2026, 3, 8, TZ)), "2026-03-08T05:00:00.000Z");
  assert.equal(iso(zonedMidnight(2026, 3, 9, TZ)), "2026-03-09T04:00:00.000Z");

  // 23:30 on Oct 31 in Toronto is already Nov 1 in UTC: still October here.
  const late = Date.parse("2026-11-01T03:30:00Z");
  assert.equal(localDay(late, TZ), "2026-10-31");
  const m = periodBounds("month", late, TZ);
  assert.equal(iso(m.start), "2026-10-01T04:00:00.000Z");
  assert.equal(iso(m.end), "2026-11-01T04:00:00.000Z");
  assert.equal(m.key, "2026-10");
  assert.equal(resetLabel("month", late, TZ), "Nov 1");
  // Half an hour later it is November, and the month resets on Dec 1 at EST midnight.
  const nov = periodBounds("month", Date.parse("2026-11-01T04:00:00Z"), TZ);
  assert.equal(nov.key, "2026-11");
  assert.equal(iso(nov.end), "2026-12-01T05:00:00.000Z");

  // The day containing the DST change is 25 hours long.
  const d = periodBounds("day", Date.parse("2026-11-01T12:00:00Z"), TZ);
  assert.equal(d.end - d.start, 25 * 3_600_000);

  // Weeks start on Monday: Sunday Nov 1 belongs to the week of Mon Oct 26.
  const w = periodBounds("week", Date.parse("2026-11-01T12:00:00Z"), TZ);
  assert.equal(iso(w.start), "2026-10-26T04:00:00.000Z");
  assert.equal(iso(w.end), "2026-11-02T05:00:00.000Z");
  assert.equal(resetLabel("week", Date.parse("2026-11-01T12:00:00Z"), TZ), "Mon Nov 2");
  // Monday 00:00 local is the first instant of the new week.
  assert.equal(periodBounds("week", Date.parse("2026-11-02T05:00:00Z"), TZ).start, Date.parse("2026-11-02T05:00:00Z"));
  assert.equal(periodBounds("week", Date.parse("2026-11-02T04:59:59Z"), TZ).start, Date.parse("2026-10-26T04:00:00Z"));
  // Year rollover.
  assert.equal(periodBounds("month", Date.parse("2026-12-31T23:00:00Z"), TZ).key, "2026-12");
  assert.equal(periodBounds("month", Date.parse("2027-01-01T05:00:00Z"), TZ).key, "2027-01");
});
