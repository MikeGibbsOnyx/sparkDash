import { test } from "node:test";
import assert from "node:assert/strict";
import { openAccessDb } from "../db.js";
import { Directory } from "../directory.js";
import { ClaimCodes } from "../claims.js";

function setup() {
  let t = 1_000_000;
  const events = [];
  const db = openAccessDb(":memory:");
  const now = () => t;
  const directory = new Directory(db, { now, onEvent: (e) => events.push(e) });
  const claims = new ClaimCodes(db, directory, { now });
  return { directory, claims, events, advance: (ms) => (t += ms) };
}
const OWNER = { role: "owner", label: "local console" };
const ADMIN = { role: "admin", label: "Ada" };

test("a person seen for the first time gets the default role, Member unless changed", () => {
  const { directory, events } = setup();
  assert.equal(directory.seen({ login: "a@x.test", name: "A" }).role, "member");
  assert.equal(events.at(-1).type, "access.person.first_seen");
  directory.setDefaultRole("local console", "auditor");
  assert.equal(directory.seen({ login: "b@x.test" }).role, "auditor");
  assert.equal(directory.seen({ login: "a@x.test" }).role, "member", "an existing person keeps their role");
  assert.throws(() => directory.setDefaultRole("x", "owner"), /Member, Auditor or Admin/);
});

test("Admins change roles except Owners; only an Owner makes or unmakes an Owner", () => {
  const { directory, events } = setup();
  directory.seen({ login: "m@x.test" });
  assert.equal(directory.setRole(ADMIN, "m@x.test", "admin").role, "admin");
  assert.match(events.at(-1).message, /from Member to Admin/);
  assert.throws(() => directory.setRole(ADMIN, "m@x.test", "owner"), /Only an Owner/);
  assert.equal(directory.setRole(OWNER, "m@x.test", "owner").role, "owner");
  assert.throws(() => directory.setRole(ADMIN, "m@x.test", "member"), /Only an Owner/);
  assert.throws(() => directory.setRole({ role: "auditor", label: "Au" }, "m@x.test", "member"), /Only an Owner|Admin role/);
  assert.throws(() => directory.setRole(OWNER, "nobody@x.test", "admin"), /hasn't|yet/);
  assert.throws(() => directory.setRole(OWNER, "m@x.test", "superuser"), /Unknown role/);
});

test("groups hold logins, tags and keys, and appear on each person", () => {
  const { directory } = setup();
  directory.seen({ login: "a@x.test" });
  const g = directory.saveGroup(ADMIN, { name: "Engineering", members: ["a@x.test", "tag:ci", "key:deploy"] });
  assert.deepEqual(g.members, ["a@x.test", "key:deploy", "tag:ci"]);
  assert.deepEqual(directory.list()[0].groups, ["Engineering"]);
  assert.throws(() => directory.saveGroup(ADMIN, { name: "Engineering", members: [] }), /already exists/);
  assert.throws(() => directory.saveGroup(ADMIN, { name: "Bad", members: ["not a selector"] }), /isn't a login/);
  directory.deleteGroup(ADMIN, g.id);
  assert.deepEqual(directory.groups(), []);
});

test("claim codes: single use, make the redeemer Owner, expire after 24 hours", () => {
  const { directory, claims, advance } = setup();
  const { code } = claims.create("local console");
  assert.match(code, /^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
  const first = claims.redeem(code.toLowerCase().replace(/-/g, " "), { login: "first@x.test" });
  assert.equal(first.ok, true);
  assert.equal(directory.get("first@x.test").role, "owner");
  const second = claims.redeem(code, { login: "second@x.test" });
  assert.equal(second.ok, false);
  assert.match(second.error, /already been used/);
  assert.equal(directory.get("second@x.test"), null);

  const late = claims.create("local console");
  advance(24 * 60 * 60 * 1000);
  const expired = claims.redeem(late.code, { login: "late@x.test" });
  assert.equal(expired.ok, false);
  assert.match(expired.error, /expired/);
});

test("claim codes are stored only as hashes, and wrong guesses are rate-limited", () => {
  const { claims, advance } = setup();
  const { code } = claims.create("x");
  const stored = claims.db.prepare("SELECT hash FROM claim_codes").all();
  assert.ok(stored.every((r) => !r.hash.includes(code.replace(/-/g, ""))));
  for (let i = 0; i < 10; i++) assert.equal(claims.redeem("WRONG-CODE-0000", { login: "g@x.test" }).status, 400);
  assert.equal(claims.redeem(code, { login: "g@x.test" }).status, 429, "even the right code waits out the lockout");
  advance(61_000);
  assert.equal(claims.redeem(code, { login: "g@x.test" }).ok, true);
});

test("createIfUnowned prints one code while nobody owns the install", () => {
  const { claims, directory } = setup();
  const lines = [];
  const code = claims.createIfUnowned((l) => lines.push(l));
  assert.ok(code && lines[0].includes(code));
  assert.equal(claims.createIfUnowned((l) => lines.push(l)), null, "a pending code isn't replaced");
  claims.redeem(code, { login: "o@x.test" });
  assert.ok(directory.hasOwner());
  assert.equal(claims.createIfUnowned((l) => lines.push(l)), null);
});
