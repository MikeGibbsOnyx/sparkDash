import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import zlib from "node:zlib";
import { once } from "node:events";
import { BUILTIN, findAll, luhn, compileCustom } from "../guardrails/detectors.js";
import { removeTools, textSlots } from "../guardrails/scan.js";
import { Guardrails } from "../guardrails/index.js";
import { CaptureStore } from "../logging/capture.js";
import { openGatewayDb } from "../store/db.js";
import { State } from "../store/state.js";
import { startGateway } from "./harness.js";

const SERVE = { "tailscale-user-login": "sam@onyx.test", "tailscale-user-name": "Sam" };
const ANTH = { "anthropic-version": "2023-06-01" };
const json = (body, extra = {}) => ({ method: "POST", headers: { "content-type": "application/json", ...SERVE, ...extra }, body: JSON.stringify(body) });
const det = (id) => BUILTIN.find((d) => d.id === id);
const finds = (id, text) => findAll(det(id), text).map((m) => m.value);

// A Visa test number (passes Luhn) and a planted secret for the end-to-end tests.
const CARD = "4111 1111 1111 1111";
const SIN = "046 454 286";

// ─── Detectors: true and false positives ──────────────────
test("detectors find what they should, and leave look-alikes alone", () => {
  assert.ok(luhn("4111111111111111") && !luhn("4111111111111112"));
  const cases = [
    ["email", "write to sam.lee+ai@onyx-labs.example.com today", ["sam.lee+ai@onyx-labs.example.com"]],
    ["email", "the @decorator and user@localhost aren't addresses", []],
    ["phone", "call (416) 555-0199 or +1 416-555-0123", ["(416) 555-0199", "+1 416-555-0123"]],
    ["phone", "build 20261013 at 14:05:33, port 5555, version 2.40.0", []],
    ["card", `card ${CARD} exp 12/29`, [CARD]],
    ["card", "order 4111111111111112, timestamp 1791913053849, uuid 123e4567-e89b-12d3", []],
    ["ssn", "SSN 123-45-6789", ["123-45-6789"]],
    ["ssn", "000-12-3456 and 666-12-3456 and 900-12-3456 are invalid; so is a date 2026-10-13", []],
    ["sin", `SIN ${SIN}`, [SIN]],
    ["sin", "046 454 287 fails Luhn", []],
    ["secret", "aws AKIAIOSFODNN7EXAMPLE and ghp_" + "a".repeat(36) + " and xoxb-1234567890-abcdefghij", ["AKIAIOSFODNN7EXAMPLE", "ghp_" + "a".repeat(36), "xoxb-1234567890-abcdefghij"]],
    ["secret", "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----", ["-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----"]],
    ["secret", "sk-ant-api03-" + "x".repeat(30), ["sk-ant-api03-" + "x".repeat(30)]],
    ["secret", "a task-list and sk-short and the word skeleton", []],
  ];
  for (const [id, text, want] of cases) assert.deepEqual(finds(id, text), want, `${id}: ${text}`);
  // Admin regexes: compiled with the fix named when unusable.
  assert.deepEqual(findAll(compileCustom({ id: "c", name: "Project code", pattern: "PRJ-\\d{4}" }), "see PRJ-1234 and PRJ-12").map((m) => m.value), ["PRJ-1234"]);
  assert.throws(() => compileCustom({ id: "c", name: "x", pattern: "(" }), /isn't a valid regular expression/);
  assert.throws(() => compileCustom({ id: "c", name: "x", pattern: "a*" }), /matches empty text/);
});

// ─── The scanner ──────────────────────────────────────────
test("scanner: message, system and tool-result text; never thinking, signatures, tool calls, media or Gemini signed parts", () => {
  const anth = {
    system: [{ type: "text", text: "sys" }],
    messages: [
      { role: "user", content: "u1" },
      { role: "assistant", content: [{ type: "thinking", thinking: "secret thought", signature: "SIG==" }, { type: "redacted_thinking", data: "ENC" }, { type: "text", text: "a1" }, { type: "tool_use", id: "tu_1", name: "x", input: { q: "args" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: [{ type: "text", text: "result" }, { type: "image", source: { type: "base64", data: "AAAA" } }] }, { type: "text", text: "u2" }] },
    ],
  };
  assert.deepEqual(textSlots("anthropic", anth).map((s) => s.get()), ["sys", "u1", "a1", "result", "u2"]);
  const resp = { instructions: "sys", input: [{ type: "reasoning", encrypted_content: "ENC" }, { role: "user", content: [{ type: "input_text", text: "u1" }] }, { type: "function_call", name: "x", arguments: "{}" }, { type: "function_call_output", call_id: "c", output: "out" }] };
  assert.deepEqual(textSlots("openai-responses", resp).map((s) => s.get()), ["sys", "u1", "out"]);
  const gem = {
    systemInstruction: { parts: [{ text: "sys" }] },
    contents: [
      { role: "user", parts: [{ text: "u1" }, { inlineData: { mimeType: "image/png", data: "AAAA" } }] },
      { role: "model", parts: [{ text: "thinking", thought: true }, { functionCall: { name: "x", args: {} }, thoughtSignature: "SIG" }, { text: "signed", thoughtSignature: "SIG2" }] },
      { role: "user", parts: [{ functionResponse: { name: "x", response: { result: "fr", n: 3 } } }] },
    ],
  };
  assert.deepEqual(textSlots("gemini", gem).map((s) => s.get()), ["sys", "u1", "fr"]);
  const chat = { messages: [{ role: "system", content: "sys" }, { role: "user", content: [{ type: "text", text: "u1" }, { type: "image_url", image_url: { url: "data:..." } }] }, { role: "tool", tool_call_id: "c", content: "out" }] };
  assert.deepEqual(textSlots("openai-chat", chat).map((s) => s.get()), ["sys", "u1", "out"]);
});

test("tool blocking removes tools in every format, and a tool choice that named one", () => {
  const blocked = (n) => n.startsWith("shell");
  const a = { tools: [{ name: "shell_exec" }, { name: "read" }], tool_choice: { type: "tool", name: "shell_exec" } };
  assert.deepEqual(removeTools("anthropic", a, blocked), ["shell_exec"]);
  assert.deepEqual(a, { tools: [{ name: "read" }] });
  const c = { tools: [{ type: "function", function: { name: "shell" } }], tool_choice: "required" };
  assert.deepEqual(removeTools("openai-chat", c, blocked), ["shell"]);
  assert.deepEqual(c, {});
  const r = { tools: [{ type: "function", name: "shell" }, { type: "web_search" }] };
  removeTools("openai-responses", r, blocked);
  assert.deepEqual(r, { tools: [{ type: "web_search" }] });
  const g = { tools: [{ functionDeclarations: [{ name: "shell" }, { name: "read" }] }, { googleSearch: {} }] };
  removeTools("gemini", g, blocked);
  assert.deepEqual(g, { tools: [{ functionDeclarations: [{ name: "read" }] }, { googleSearch: {} }] });
});

test("redaction is deterministic: the same value gets the same placeholder, turn after turn", () => {
  const db = openGatewayDb(":memory:");
  const g = new Guardrails(db, { state: new State(db) });
  g.setMode("email", "redact", "t");
  g.setMode("card", "redact", "t");
  const turn1 = { messages: [{ role: "user", content: `I'm a@x.com, card ${CARD}; cc b@y.org and a@x.com` }] };
  g.scan("anthropic", turn1);
  assert.equal(turn1.messages[0].content, "I'm [EMAIL_1], card [CARD_1]; cc [EMAIL_2] and [EMAIL_1]");
  // Next turn: the client resends the original history plus a new message.
  const turn2 = { messages: [{ role: "user", content: `I'm a@x.com, card ${CARD}; cc b@y.org and a@x.com` }, { role: "assistant", content: "ok" }, { role: "user", content: "also c@z.net and b@y.org" }] };
  g.scan("anthropic", turn2);
  assert.equal(turn2.messages[0].content, turn1.messages[0].content, "history redacts the same way");
  assert.equal(turn2.messages[2].content, "also [EMAIL_3] and [EMAIL_2]");
});

// ─── Through the Gateway ──────────────────────────────────
async function setMode(g, id, mode) {
  const r = await g.admin("PATCH", `/guardrails/detectors/${id}`, { mode });
  assert.equal(r.status, 200, r.text);
}

test("block: a planted card number never leaves the machine; the client gets a 400 naming the detector, not the number", async (t) => {
  const g = await startGateway(t);
  await g.setup();
  await setMode(g, "card", "block");
  const before = g.upstream.seen.length;
  const r = await g.call("/v1/messages", json({ model: "claude-test", max_tokens: 5, messages: [{ role: "user", content: `charge ${CARD} please` }] }, ANTH));
  assert.equal(r.status, 400);
  assert.equal(r.headers.get("x-should-retry"), "false");
  assert.equal(r.json().error.type, "invalid_request_error");
  assert.match(r.json().error.message, /Payment card/);
  assert.ok(!r.text.includes("4111"), "the matched text is never echoed");
  assert.equal(g.upstream.seen.length, before, "nothing reached the provider");
  const row = g.gw.db.prepare("SELECT * FROM requests ORDER BY id DESC LIMIT 1").get();
  assert.equal(row.usage_state, "blocked");
  assert.deepEqual(JSON.parse(row.guardrail_hits), [{ detector: "card", name: "Payment card", action: "blocked", count: 1 }]);
  assert.ok(!JSON.stringify(g.gw.db.prepare("SELECT * FROM requests").all()).includes("4111"));
  // Gemini blocks in its own format.
  const gm = await g.call("/v1beta/models/gemini-test:generateContent", json({ contents: [{ role: "user", parts: [{ text: `card ${CARD}` }] }] }));
  assert.equal(gm.status, 400);
  assert.equal(gm.json().error.status, "INVALID_ARGUMENT");
});

test("redact: the provider sees placeholders; thinking blocks and signatures reach it byte for byte", async (t) => {
  const g = await startGateway(t);
  await g.setup();
  await setMode(g, "card", "redact");
  await setMode(g, "email", "flag");
  const thinking = { type: "thinking", thinking: `I noted the card ${CARD} earlier`, signature: "EqQBCkYIBxgCKkB+/sig==" };
  const body = {
    model: "claude-test",
    max_tokens: 50,
    messages: [
      { role: "user", content: `my card is ${CARD}, email me at sam@onyx.test` },
      { role: "assistant", content: [thinking, { type: "text", text: "Got it." }] },
      { role: "user", content: "thanks" },
    ],
  };
  const before = g.upstream.seen.length;
  const r = await g.call("/v1/messages", json(body, ANTH));
  assert.equal(r.status, 200);
  const sent = g.upstream.seen.slice(before).find((s) => s.path === "/v1/messages").body;
  assert.equal(sent.messages[0].content, "my card is [CARD_1], email me at sam@onyx.test", "card redacted, email only flagged");
  assert.deepEqual(sent.messages[1].content[0], thinking, "thinking block untouched, signature intact");
  assert.equal(sent.model, "claude-test");
  const hits = JSON.parse(g.gw.db.prepare("SELECT guardrail_hits FROM requests ORDER BY id DESC LIMIT 1").get().guardrail_hits);
  assert.deepEqual(hits.map((h) => [h.detector, h.action, h.count]).sort(), [["card", "redacted", 1], ["email", "flagged", 1]]);
});

test("guardrails off (the default): bodies pass byte for byte", async (t) => {
  const g = await startGateway(t);
  await g.setup();
  const raw = '{"model":"claude-test",  "max_tokens":5,"messages":[{"role":"user","content":"card 4111 1111 1111 1111"}]}';
  const before = g.upstream.seen.length;
  await fetch(`${g.base}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", ...SERVE, ...ANTH }, body: raw });
  const s = g.upstream.seen.slice(before).find((x) => x.path === "/v1/messages");
  assert.equal(JSON.stringify(s.body), JSON.stringify(JSON.parse(raw)));
  assert.equal(Number(s.headers["content-length"]), Buffer.byteLength(raw), "same length: not re-serialised");
});

test("tool blocking through the Gateway", async (t) => {
  const g = await startGateway(t);
  await g.setup();
  await g.admin("PUT", "/guardrails/tools", { blockedTools: ["shell*", "mcp__github__delete_*"] });
  const before = g.upstream.seen.length;
  await g.call("/v1/messages", json({ model: "claude-test", max_tokens: 5, tools: [{ name: "shell_exec", input_schema: {} }, { name: "Read", input_schema: {} }, { name: "mcp__github__delete_repo", input_schema: {} }], messages: [{ role: "user", content: "hi" }] }, ANTH));
  const sent = g.upstream.seen.slice(before).find((s) => s.path === "/v1/messages").body;
  assert.deepEqual(sent.tools.map((x) => x.name), ["Read"]);
  const hits = JSON.parse(g.gw.db.prepare("SELECT guardrail_hits FROM requests ORDER BY id DESC LIMIT 1").get().guardrail_hits);
  assert.deepEqual(hits, [{ detector: "tools", name: "Tool blocking", action: "removed", count: 2, tools: ["shell_exec", "mcp__github__delete_repo"] }]);
});

test("the pre-request hook: allow, block, replace (model kept), and timeouts failing open or closed", async (t) => {
  let answer = { action: "allow" };
  let delay = 0;
  const seen = [];
  const hook = http.createServer(async (req, res) => {
    let b = "";
    for await (const c of req) b += c;
    seen.push(JSON.parse(b));
    await new Promise((r) => setTimeout(r, delay));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(answer));
  });
  hook.listen(0, "127.0.0.1");
  await once(hook, "listening");
  t.after(() => new Promise((r) => (hook.closeAllConnections(), hook.close(r))));
  const g = await startGateway(t);
  await g.setup();
  const url = `http://127.0.0.1:${hook.address().port}/check`;
  assert.equal((await g.admin("PUT", "/guardrails/hook", { url, failOpen: true })).status, 200);
  const send = () => g.call("/v1/messages", json({ model: "claude-test", max_tokens: 5, messages: [{ role: "user", content: "hello" }] }, ANTH));

  assert.equal((await send()).status, 200);
  assert.equal(seen[0].identity, "sam@onyx.test");
  assert.equal(seen[0].body.messages[0].content, "hello");

  answer = { action: "block", message: "Not during the audit window." };
  const b = await send();
  assert.equal(b.status, 400);
  assert.match(b.json().error.message, /Not during the audit window/);

  answer = { action: "replace", body: { model: "claude-other", max_tokens: 5, messages: [{ role: "user", content: "rewritten" }] } };
  const before = g.upstream.seen.length;
  assert.equal((await send()).status, 200);
  const sent = g.upstream.seen.slice(before).find((s) => s.path === "/v1/messages").body;
  assert.equal(sent.messages[0].content, "rewritten");
  assert.equal(sent.model, "claude-test", "a hook can't switch the model grants and budgets checked");

  answer = { action: "allow" };
  delay = 2500;
  assert.equal((await send()).status, 200, "fail open: a slow hook lets the request through");
  await g.admin("PUT", "/guardrails/hook", { url, failOpen: false });
  const closed = await send();
  assert.equal(closed.status, 400, "fail closed");
  assert.match(closed.json().error.message, /didn't answer/);
  // A hook outside loopback, LAN or tailnet is a finding.
  await g.admin("PUT", "/guardrails/hook", { url: "https://hooks.example.com/check" });
  assert.ok((await g.admin("GET", "/status")).json().findings.some((f) => f.id === "hook-public"));
});

test("detector test box shows what would be redacted; nothing is stored", async (t) => {
  const g = await startGateway(t);
  const r = (await g.admin("POST", "/guardrails/test", { text: `mail a@b.co, card ${CARD}, ref PRJ-0042`, pattern: "PRJ-\\d{4}" })).json();
  assert.equal(r.redacted, "mail [EMAIL_1], card [CARD_1], ref [NEW_DETECTOR_1]");
  assert.equal(g.gw.db.prepare("SELECT count(*) AS n FROM requests").get().n, 0);
  const bad = await g.admin("POST", "/guardrails/test", { text: "x", pattern: "(" });
  assert.equal(bad.status, 400);
});

// ─── Capture, retention, audit, export ────────────────────
test("metadata only (the default) writes no body files", async (t) => {
  const g = await startGateway(t);
  await g.setup();
  await g.call("/v1/messages", json({ model: "claude-test", max_tokens: 5, stream: true, messages: [{ role: "user", content: "hi" }] }, ANTH));
  await g.call("/v1/chat/completions", json({ model: "gpt-test", messages: [{ role: "user", content: "hi" }] }));
  assert.equal(fs.existsSync(path.join(g.dataDir, "bodies")), false);
  assert.equal(g.gw.db.prepare("SELECT count(*) AS n FROM requests WHERE body_path IS NOT NULL").get().n, 0);
  const row = g.gw.db.prepare("SELECT headers FROM requests ORDER BY id DESC LIMIT 1").get();
  assert.deepEqual(Object.keys(JSON.parse(row.headers)), ["user-agent"].filter((k) => JSON.parse(row.headers)[k]));
});

test("full capture: bodies stored 0600 and gzipped; every read audited with the reader's name; JSONL export is metadata only", async (t) => {
  const g = await startGateway(t);
  await g.setup();
  const r = await g.admin("PATCH", "/privacy/capture", { mode: "full" });
  assert.equal(r.json().capture.mode, "full");
  await g.call("/v1/messages", json({ model: "claude-test", max_tokens: 5, stream: true, messages: [{ role: "user", content: "the secret plan" }] }, { ...ANTH, authorization: "Bearer sparkdash", "x-claude-code-session-id": "s-1" }));
  const row = g.gw.db.prepare("SELECT * FROM requests ORDER BY id DESC LIMIT 1").get();
  assert.equal(row.body_path, `bodies/${row.id}.json.gz`);
  const file = path.join(g.dataDir, row.body_path);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const doc = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString());
  assert.ok(doc.request.includes("the secret plan"));
  assert.ok(doc.response.includes("message_stop"));
  // Stored headers are the allowlist; auth never.
  const hdrs = JSON.parse(row.headers);
  assert.equal(hdrs["anthropic-version"], "2023-06-01");
  assert.equal(hdrs["x-claude-code-session-id"], "s-1");
  assert.equal(hdrs.authorization, undefined);

  const list = (await g.admin("GET", "/requests?limit=5")).json();
  assert.equal(list.requests[0].hasContent, true);
  assert.ok(!JSON.stringify(list).includes("the secret plan"), "the list never carries content");
  const content = await g.admin("GET", `/requests/${row.id}/content`, undefined, "Ava Auditor");
  assert.ok(content.json().content.request.includes("the secret plan"));
  const ev = g.gw.state.eventsSince(0).filter((e) => e.action === "content.viewed");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].actor, "Ava Auditor");
  assert.equal(ev[0].target, `request ${row.id}`);

  const exp = (await g.admin("GET", `/export?from=0&to=${Date.now() + 1000}`)).json();
  assert.ok(exp.count >= 1);
  const first = JSON.parse(exp.jsonl.trim().split("\n").at(-1));
  assert.equal(first.id, row.id);
  assert.equal(first.headers["x-claude-code-session-id"], "s-1");
  assert.ok(!exp.jsonl.includes("the secret plan"));
});

test("retention purge with a fake clock: content after 7 days, records after 400; rollups stay", async (t) => {
  const g = await startGateway(t);
  await g.setup();
  await g.admin("PATCH", "/privacy/capture", { mode: "full" });
  await g.call("/v1/messages", json({ model: "claude-test", max_tokens: 5, messages: [{ role: "user", content: "hi" }] }, ANTH));
  const row = g.gw.db.prepare("SELECT * FROM requests ORDER BY id DESC LIMIT 1").get();
  const file = path.join(g.dataDir, row.body_path);
  const DAY = 86_400_000;
  const at = (days) => new CaptureStore({ dataDir: g.dataDir, state: g.gw.state, db: g.gw.db, now: () => row.ts + days * DAY });
  assert.deepEqual(at(6).purge(), { bodies: 0, metadata: 0 });
  assert.ok(fs.existsSync(file));
  assert.equal(at(8).purge().bodies, 1);
  assert.equal(fs.existsSync(file), false);
  assert.equal(g.gw.db.prepare("SELECT body_path FROM requests WHERE id = ?").get(row.id).body_path, null);
  assert.equal(at(399).purge().metadata, 0);
  assert.equal(at(401).purge().metadata, 1);
  assert.equal(g.gw.db.prepare("SELECT count(*) AS n FROM requests WHERE id = ?").get(row.id).n, 0);
  assert.ok(g.gw.db.prepare("SELECT sum(requests) AS n FROM usage_daily").get().n >= 1, "daily rollups outlive the request log");
  // Retention is configurable; content can't outlive its record.
  assert.equal((await g.admin("PATCH", "/privacy/capture", { retention: { bodiesDays: 30, metadataDays: 10 } })).status, 400);
  assert.equal((await g.admin("PATCH", "/privacy/capture", { retention: { bodiesDays: 1 } })).json().capture.retention.bodiesDays, 1);
});
