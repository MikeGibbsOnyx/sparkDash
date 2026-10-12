import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveIdentity, decodeHeaderWord } from "../resolve.js";
import { createWhois, parseWhois } from "../whois.js";
import { forwardedFor, isLoopbackIp, isTailnetIp } from "../net.js";

const MIKE = { UserProfile: { LoginName: "mike@onyx.test", DisplayName: "Mike" }, Node: { Name: "mike-den.tail1.ts.net.", Tags: null } };
const CI = { UserProfile: { LoginName: "tagged-devices" }, Node: { Name: "ci-runner.tail1.ts.net.", Tags: ["tag:ci"] } };

function req({ peer = "127.0.0.1", port = 50000, headers = {} } = {}) {
  return { socket: { remoteAddress: peer, remotePort: port }, headers };
}
const whoisOf = (table) => async (ip) => (ip in table ? parseWhois(table[ip]) : null);
const opts = (extra = {}) => ({ listenerLoopback: true, whois: whoisOf({ "100.65.30.25": MIKE, "100.70.0.9": CI }), ...extra });

test("addresses: loopback, tailnet ranges and the right-most forwarded IP", () => {
  assert.ok(isLoopbackIp("127.0.0.1") && isLoopbackIp("::1") && isLoopbackIp("::ffff:127.0.0.1"));
  assert.ok(!isLoopbackIp("10.0.0.1"));
  assert.ok(isTailnetIp("100.64.0.1") && isTailnetIp("100.127.255.255") && isTailnetIp("fd7a:115c:a1e0::53"));
  assert.ok(!isTailnetIp("100.128.0.1") && !isTailnetIp("100.63.0.1") && !isTailnetIp("8.8.8.8") && !isTailnetIp("fd7a:115c:a1e1::1"));
  assert.equal(forwardedFor("1.2.3.4, 100.65.30.25"), "100.65.30.25");
  assert.equal(forwardedFor(""), "");
});

test("1. Serve headers name the person when the peer and the listener are loopback", async () => {
  const id = await resolveIdentity(
    req({ headers: { "tailscale-user-login": "Mike@Onyx.test", "tailscale-user-name": "=?utf-8?q?Ren=C3=A9_G?=", "x-forwarded-for": "100.65.30.25" } }),
    opts()
  );
  assert.equal(id.ok, true);
  assert.equal(id.via, "serve");
  assert.equal(id.login, "mike@onyx.test");
  assert.equal(id.name, "René G");
  assert.equal(id.device, "mike-den");
});

test("Serve headers are not trusted on a listener that isn't loopback-bound", async () => {
  const id = await resolveIdentity(req({ headers: { "tailscale-user-login": "mike@onyx.test" } }), opts({ listenerLoopback: false }));
  assert.equal(id.ok, false);
  assert.equal(id.status, 401);
});

test("Serve headers from a non-loopback peer are ignored (spoofing)", async () => {
  const id = await resolveIdentity(req({ peer: "10.0.0.50", headers: { "tailscale-user-login": "owner@onyx.test" } }), opts());
  assert.equal(id.ok, false);
  assert.match(id.error, /10\.0\.0\.50/);
});

test("2. whois names a direct tailnet peer, and a loopback peer forwarding a tailnet IP", async () => {
  const direct = await resolveIdentity(req({ peer: "100.65.30.25" }), opts());
  assert.deepEqual([direct.ok, direct.via, direct.login, direct.device], [true, "whois", "mike@onyx.test", "mike-den"]);
  const forwarded = await resolveIdentity(req({ headers: { "x-forwarded-for": "100.65.30.25" } }), opts());
  assert.deepEqual([forwarded.ok, forwarded.via, forwarded.login], [true, "whois", "mike@onyx.test"]);
});

test("whois marks tagged devices, which are never people", async () => {
  const id = await resolveIdentity(req({ peer: "100.70.0.9" }), opts());
  assert.equal(id.ok, true);
  assert.equal(id.tagged, true);
  assert.equal(id.login, null);
  assert.deepEqual(id.tags, ["tag:ci"]);
});

test("whois failures and unknown tailnet IPs are refused with a fix", async () => {
  const unknown = await resolveIdentity(req({ peer: "100.99.0.1" }), opts());
  assert.equal(unknown.ok, false);
  assert.match(unknown.fix, /tailnet/);
  const broken = await resolveIdentity(req({ peer: "100.65.30.25" }), opts({ whois: async () => { throw new Error("socket gone"); } }));
  assert.equal(broken.ok, false);
  assert.match(broken.fix, /tailscaled/);
});

test("3. the local console: loopback, no Serve headers, no forwarded IP", async () => {
  const id = await resolveIdentity(req(), opts());
  assert.deepEqual([id.ok, id.via], [true, "local"]);
  const off = await resolveIdentity(req(), opts({ localConsole: false }));
  assert.equal(off.ok, false);
  assert.match(off.error, /SPARKDASH_LOCAL_CONSOLE=0/);
});

test("Funnel: a loopback request forwarding a public IP is refused, even with a login header", async () => {
  for (const headers of [{ "x-forwarded-for": "203.0.113.7" }, { "x-forwarded-for": "203.0.113.7", "tailscale-user-login": "mike@onyx.test" }]) {
    const id = await resolveIdentity(req({ headers }), opts());
    assert.equal(id.ok, false, JSON.stringify(headers));
    assert.equal(id.status, 401);
    assert.match(id.error, /203\.0\.113\.7/);
    assert.match(id.fix, /Tailscale Serve|SPARKDASH_TOKEN/);
  }
});

test("a reverse proxy forwarding a LAN address is refused with the fix", async () => {
  const id = await resolveIdentity(req({ headers: { "x-forwarded-for": "192.168.1.20" } }), opts());
  assert.equal(id.ok, false);
  assert.match(id.fix, /SPARKDASH_TOKEN/);
});

test("a direct non-tailnet peer is refused", async () => {
  const id = await resolveIdentity(req({ peer: "192.168.1.20" }), opts({ listenerLoopback: false }));
  assert.equal(id.ok, false);
  assert.equal(id.status, 401);
});

test("a gateway key, when the caller supplies a lookup, wins over everything else", async () => {
  const id = await resolveIdentity(req({ peer: "100.65.30.25" }), opts({ gatewayKey: async () => ({ login: null, keyName: "ci" }) }));
  assert.equal(id.via, "key");
  assert.equal(id.keyName, "ci");
});

test("whois answers are cached 60 seconds per address", async () => {
  let calls = 0;
  let t = 0;
  const whois = createWhois({ query: async () => (calls++, MIKE), now: () => t });
  await whois("100.65.30.25", 4000);
  await whois("100.65.30.25", 4000);
  assert.equal(calls, 1);
  await whois("100.65.30.25", 4001);
  assert.equal(calls, 2, "a different port is a different cache entry");
  t = 60_001;
  await whois("100.65.30.25", 4000);
  assert.equal(calls, 3, "expired after 60 s");
});

test("RFC 2047 header words decode; plain values pass through", () => {
  assert.equal(decodeHeaderWord("Michael Gibbs"), "Michael Gibbs");
  assert.equal(decodeHeaderWord("=?utf-8?b?UmVuw6k=?="), "René");
});
