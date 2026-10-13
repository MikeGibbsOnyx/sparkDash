import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decrypt, encrypt, keyFromString } from "../../shared/crypto.js";
import { redact } from "../../shared/redact.js";
import { createVault, loadVaultKey } from "../credentials/vault.js";
import { detectProvider } from "../providers/catalog.js";
import { globMatch, selectorMatches, groupsFor } from "../policy/grants.js";
import { bindHostClass, loadConfig } from "../config.js";
import { checkOutboundUrl } from "../security.js";
import { KEYS, startGateway } from "./harness.js";

test("encryption round trip, and the format the Observer's secretsStore already uses", () => {
  const key = crypto.randomBytes(32);
  const blob = encrypt("sk-ant-secret", key);
  assert.equal(decrypt(blob, key), "sk-ant-secret");
  assert.throws(() => decrypt(blob, crypto.randomBytes(32)), "a wrong key fails, never returns garbage");
  const buf = Buffer.from(blob, "base64");
  buf[buf.length - 1] ^= 1;
  assert.throws(() => decrypt(buf.toString("base64"), key), "tampering is detected");
  // iv(12) | tag(16) | ciphertext, base64, exactly as server/secretsStore.js wrote it before the move.
  assert.equal(Buffer.from(blob, "base64").length, 12 + 16 + "sk-ant-secret".length);
  assert.deepEqual(keyFromString("a".repeat(64)), Buffer.from("a".repeat(64), "hex"));
});

test("the vault key file is created 0600 and never overwritten; GATEWAY_SECRETS_KEY wins", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sd-vault-"));
  try {
    const keyPath = path.join(dir, "secrets.key");
    const k1 = loadVaultKey({ secretsKey: "", secretsKeyPath: keyPath });
    if (process.platform !== "win32") assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600);
    const k2 = loadVaultKey({ secretsKey: "", secretsKeyPath: keyPath });
    assert.deepEqual(k1, k2);
    const v = createVault(k1);
    assert.equal(v.open(v.seal("x")), "x");
    assert.notDeepEqual(loadVaultKey({ secretsKey: "passphrase", secretsKeyPath: keyPath }), k1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("paste-to-detect: the prefix picks the provider", () => {
  assert.equal(detectProvider("sk-ant-api03-x"), "anthropic");
  assert.equal(detectProvider("sk-or-v1-x"), "openrouter");
  assert.equal(detectProvider("AIzaSyX"), "gemini");
  assert.equal(detectProvider("sk-proj-x"), "openai");
  assert.equal(detectProvider("something-else"), null);
});

test("redaction masks every key shape it knows, and named secrets", () => {
  const line = `x-api-key: ${KEYS.anthropic} Authorization: Bearer ${KEYS.openai} key=${KEYS.gemini} sdgw_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 token abc123secret`;
  const out = redact(line, ["abc123secret"]);
  for (const k of [KEYS.anthropic, KEYS.openai, KEYS.gemini, "sdgw_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345", "abc123secret"]) assert.ok(!out.includes(k), k.slice(0, 10));
});

test("bind rules: loopback, tailnet and private are fine; public needs the opt-in", () => {
  assert.equal(bindHostClass("127.0.0.1"), "loopback");
  assert.equal(bindHostClass("100.79.61.0"), "tailnet");
  assert.equal(bindHostClass("192.168.1.5"), "private");
  assert.equal(bindHostClass("0.0.0.0"), "public");
  assert.throws(() => loadConfig({ GATEWAY_BIND_HOST: "0.0.0.0" }), /GATEWAY_ALLOW_PUBLIC_BIND/);
  assert.equal(loadConfig({ GATEWAY_BIND_HOST: "0.0.0.0", GATEWAY_ALLOW_PUBLIC_BIND: "1" }).bindClass, "public");
});

test("SSRF: admin-set URLs must be http(s) and never link-local or cloud metadata", async () => {
  assert.equal(await checkOutboundUrl("https://api.anthropic.com", { resolve: async () => [{ address: "160.79.104.10" }] }), null);
  assert.equal(await checkOutboundUrl("http://192.168.1.20:8000"), null, "LAN model servers are fine");
  assert.match(await checkOutboundUrl("http://169.254.169.254/latest/meta-data"), /metadata/);
  assert.match(await checkOutboundUrl("http://metadata.internal", { resolve: async () => [{ address: "169.254.169.254" }] }), /metadata/);
  assert.match(await checkOutboundUrl("file:///etc/passwd"), /http/);
  assert.match(await checkOutboundUrl("https://user:pw@example.com"), /credentials/);
});

test("grants: selectors and model patterns", () => {
  assert.ok(globMatch("claude-*", "claude-sonnet-4-6"));
  assert.ok(globMatch("spark-1/*", "spark-1/qwen3-coder"));
  assert.ok(!globMatch("spark-1/*", "spark-10/qwen"));
  assert.ok(globMatch("*", "anything"));
  const who = { kind: "person", login: "sam@onyx.test", tags: [], keyName: null, groups: ["Engineering"] };
  assert.ok(selectorMatches("group:engineering", who));
  assert.ok(selectorMatches("SAM@onyx.test", who));
  assert.ok(!selectorMatches("local", who));
  assert.ok(selectorMatches("tag:ci", { kind: "tag", tags: ["tag:ci"] }));
  assert.ok(selectorMatches("key:deploy", { kind: "key", keyName: "deploy", tags: [] }));
  assert.deepEqual(groupsFor({ groups: [{ name: "Eng", members: ["sam@onyx.test", "tag:ci"] }] }, { login: "sam@onyx.test", tags: [] }), ["Eng"]);
});

test("Test and save: a failing key saves nothing unless asked; saved keys are write-only", async (t) => {
  const g = await startGateway(t);
  const bad = (await g.admin("POST", "/providers", { type: "anthropic", key: "sk-ant-api03-WRONGkeyWRONGkeyWRONGkey", baseUrl: g.upstream.url })).json();
  assert.equal(bad.saved, false);
  assert.match(bad.message, /rejected this key \(401\)\. Copy the whole key/);
  assert.equal((await g.admin("GET", "/providers")).json().providers.length, 0);

  const ok = (await g.admin("POST", "/providers", { key: KEYS.anthropic, baseUrl: g.upstream.url })).json();
  assert.equal(ok.saved, true, "type detected from the prefix");
  assert.equal(ok.message, "Works. 2 models available.");
  assert.equal(ok.provider.keyLast4, KEYS.anthropic.slice(-4));
  assert.equal(ok.provider.status, "Working");
  assert.equal(ok.provider.addedBy, "Test Admin");

  const anyway = (await g.admin("POST", "/providers", { type: "openai", key: "sk-proj-WRONGWRONGWRONGWRONGWRONG", baseUrl: g.upstream.url, saveAnyway: true })).json();
  assert.equal(anyway.saved, true);
  assert.equal(anyway.provider.status, "Failing");
  const untested = (await g.admin("POST", "/providers", { type: "gemini", key: KEYS.gemini, baseUrl: g.upstream.url, skipTest: true })).json();
  assert.equal(untested.provider.status, "Not tested");

  const listing = (await g.admin("GET", "/providers")).text;
  for (const k of [KEYS.anthropic, KEYS.gemini]) assert.ok(!listing.includes(k));
});

test("Replace key tests the new key first and keeps the old one if it fails; Remove shows impact first", async (t) => {
  const g = await startGateway(t);
  await g.setup();
  const anth = g.gw.providers.list().find((p) => p.type === "anthropic");
  const failed = (await g.admin("PUT", `/providers/${anth.id}/key`, { key: "sk-ant-api03-NEWbutWRONGNEWbutWRONG" })).json();
  assert.equal(failed.replaced, false);
  assert.match(failed.message, /old key is still in use/);
  assert.equal(g.gw.providers.secretFor(anth.id), KEYS.anthropic);

  await g.call("/v1/messages", { method: "POST", headers: { "content-type": "application/json", "tailscale-user-login": "sam@onyx.test", "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: "claude-test", max_tokens: 5, messages: [] }) });
  const impact = (await g.admin("GET", `/providers/${anth.id}/impact`)).json();
  assert.deepEqual(impact, { people: 1, requests: 1, modelsUsed: 1, modelsServed: 2 });
  assert.equal((await g.admin("DELETE", `/providers/${anth.id}`)).status, 200);
  assert.equal(g.gw.db.prepare("SELECT count(*) n FROM provider_secrets WHERE provider_id = ?").get(anth.id).n, 0, "the ciphertext goes with it");
});

test("a key from GATEWAY_*_API_KEY shows as set by environment variable and can't be edited", async (t) => {
  const g = await startGateway(t, { env: { GATEWAY_ANTHROPIC_API_KEY: KEYS.anthropic } });
  await g.gw.providers.syncEnvProviders({ test: false });
  const p = g.gw.providers.list()[0];
  assert.equal(p.keySource, "env");
  assert.equal(p.keyLast4, KEYS.anthropic.slice(-4));
  assert.equal((await g.admin("PUT", `/providers/${p.id}/key`, { key: KEYS.anthropic })).status, 409);
  assert.equal((await g.admin("DELETE", `/providers/${p.id}`)).status, 409);
  assert.equal(g.gw.db.prepare("SELECT count(*) n FROM provider_secrets").get().n, 0, "environment keys are never written to disk");
});

test("the internal API needs the shared secret; the directory push feeds group grants; audit events flow out", async (t) => {
  const g = await startGateway(t);
  await g.setup();
  assert.equal((await g.internalCall("GET", "/internal/health", null, "wrong")).status, 401);
  assert.equal((await g.internalCall("GET", "/internal/health", null, "")).status, 401);
  await g.internalCall("PUT", "/internal/directory", { people: [{ login: "sam@onyx.test", name: "Sam", role: "member" }], groups: [{ name: "Eng", members: ["sam@onyx.test"] }] });
  g.gw.db.prepare("UPDATE grants SET selectors = ?, model_patterns = ?").run(JSON.stringify(["group:Eng"]), JSON.stringify(["gpt-*"]));
  const r = await g.call("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "tailscale-user-login": "sam@onyx.test" }, body: JSON.stringify({ model: "gpt-test", messages: [] }) });
  assert.equal(r.status, 200);
  const me = (await g.call("/me", { headers: { "tailscale-user-login": "sam@onyx.test" } })).json();
  assert.equal(me.who.name, "Sam");
  assert.equal(me.who.role, "member");
  assert.equal(me.lastRequest.model, "gpt-test");
  const events = (await g.internalCall("GET", "/internal/events?since=0")).json().events;
  assert.ok(events.some((e) => e.action === "provider.added"));
  assert.ok(events.some((e) => e.action === "gateway.enabled"));
});

test("personal keys from /me act as the person; Admins can turn them off", async (t) => {
  const g = await startGateway(t);
  await g.setup();
  const sam = { "tailscale-user-login": "sam@onyx.test", "content-type": "application/json" };
  const made = await g.call("/me/keys", { method: "POST", headers: sam, body: JSON.stringify({ name: "laptop-off-tailnet", expiry: "30" }) });
  assert.equal(made.status, 201);
  const { key } = made.json();
  const viaKey = await g.call("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ model: "gpt-test", messages: [] }) });
  assert.equal(viaKey.status, 200);
  assert.equal(g.gw.db.prepare("SELECT identity FROM requests ORDER BY id DESC LIMIT 1").get().identity, "sam@onyx.test");
  assert.equal((await g.call("/me/keys", { headers: { "tailscale-user-login": "pat@onyx.test" } })).json().keys.length, 0, "only your own keys");
  await g.admin("PATCH", "/settings", { personalKeys: false });
  assert.equal((await g.call("/me/keys", { method: "POST", headers: sam, body: JSON.stringify({ name: "another" }) })).status, 403);
});

test("no secret in any response, log, the database file or the audit trail", async (t) => {
  const g = await startGateway(t);
  await g.setup();
  const oauth = "sk-ant-oat01-PLANTEDoauthTOKEN0000000000000000000000000000000000";
  const gwKey = (await g.admin("POST", "/keys", { name: "planted" })).json().key;
  g.seenResponses.pop(); // the create response is the one place a gateway key is shown

  const S = { "tailscale-user-login": "sam@onyx.test", "content-type": "application/json" };
  const hits = [
    ["/v1/messages", { model: "claude-test", max_tokens: 5, messages: [] }, { "anthropic-version": "2023-06-01", authorization: `Bearer ${oauth}` }],
    ["/v1/messages", { model: "claude-nope", max_tokens: 5, messages: [] }, { "anthropic-version": "2023-06-01", "x-api-key": KEYS.anthropic }],
    ["/v1/chat/completions", { model: "gpt-test", messages: [] }, { authorization: `Bearer ${KEYS.openai}` }],
    ["/v1/chat/completions", { model: "gpt-test", messages: [] }, { authorization: `Bearer ${gwKey}` }],
    ["/v1/chat/completions", { model: "gpt-test", messages: [] }, { authorization: `Bearer ${gwKey}x` }],
    ["/v1beta/models/gemini-test:generateContent?key=" + KEYS.gemini, { contents: [] }, {}],
  ];
  for (const [p, body, h] of hits) await g.call(p, { method: "POST", headers: { ...S, ...h }, body: JSON.stringify(body) });
  for (const p of ["/v1/models", "/v1beta/models", "/me", "/me/keys", "/me/usage"]) await g.call(p, { headers: S });
  // Phase 3: a budget that refuses, a streamed chat with the hidden usage chunk, and every usage view.
  await g.admin("POST", "/budgets", { name: "planted budget", scope: "everyone", period: "day", limitTokens: 1 });
  await g.call("/v1/chat/completions", { method: "POST", headers: { ...S, authorization: `Bearer ${KEYS.openai}` }, body: JSON.stringify({ model: "gpt-test", stream: true, messages: [] }) });
  await g.call("/v1/messages", { method: "POST", headers: { ...S, "anthropic-version": "2023-06-01", "x-api-key": KEYS.anthropic }, body: JSON.stringify({ model: "claude-test", max_tokens: 5, messages: [] }) });
  await g.internalCall("POST", "/internal/energy", { timeZone: "America/Toronto", rate: 0.1, minutes: [{ machine: "spark-1", minute: Date.now() - 600_000, wh: 1, serverTokens: 5 }] });
  for (const p of ["/budgets", "/usage?range=all&groupBy=person", "/usage?range=all&groupBy=session", "/usage/daily?range=all", "/usage/energy?range=all", "/usage/local"]) await g.admin("GET", p);
  await g.admin("POST", "/grants/preview", { draft: { name: "x", selectors: ["*"], modelPatterns: ["*"] } });
  for (const p of ["/status", "/providers", "/models", "/keys", "/grants", "/local-servers", "/settings"]) await g.admin("GET", p);
  for (const p of g.gw.providers.list()) {
    await g.admin("POST", `/providers/${p.id}/test`);
    await g.admin("GET", `/providers/${p.id}/impact`);
  }
  await g.admin("PUT", `/providers/${g.gw.providers.list()[0].id}/key`, { key: KEYS.anthropic + "WRONG" });
  await g.internalCall("GET", "/internal/health");
  await g.internalCall("GET", "/internal/events?since=0");

  const everything = [...g.seenResponses, ...g.logs, JSON.stringify(g.gw.db.prepare("SELECT * FROM audit").all()), JSON.stringify(g.gw.db.prepare("SELECT * FROM requests").all()), JSON.stringify(g.gw.db.prepare("SELECT * FROM usage_daily").all())].join("\n");
  g.gw.db.pragma("wal_checkpoint(TRUNCATE)");
  const dbBytes = fs.readFileSync(path.join(g.dataDir, "gateway.db")).toString("latin1");
  for (const [name, secret] of Object.entries({ ...KEYS, oauth, gwKey })) {
    assert.equal(everything.includes(secret), false, `${name} appears in a response, log or table`);
    assert.equal(dbBytes.includes(secret), false, `${name} appears in plaintext in gateway.db`);
  }
});
