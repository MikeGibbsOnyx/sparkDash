import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, migrate } from "../sqlite.js";

test("migrations run in order, record user_version, and resume where they stopped", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sd-sqlite-"));
  const file = path.join(dir, "t.db");
  try {
    const db = openDatabase(file, ["CREATE TABLE a (x)"]);
    assert.equal(db.pragma("user_version", { simple: true }), 1);
    assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
    db.close();
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);

    const steps = ["CREATE TABLE a (x)", "INSERT INTO a VALUES (1)", (d) => d.exec("INSERT INTO a VALUES (2)")];
    const again = openDatabase(file, steps);
    assert.equal(again.pragma("user_version", { simple: true }), 3);
    assert.deepEqual(again.prepare("SELECT x FROM a ORDER BY x").all().map((r) => r.x), [1, 2]);
    again.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed migration rolls back and leaves the version where it was", () => {
  const db = openDatabase(":memory:", ["CREATE TABLE a (x)"]);
  assert.throws(() => migrate(db, ["CREATE TABLE a (x)", "INSERT INTO a VALUES (1); INSERT INTO missing VALUES (1)"]));
  assert.equal(db.pragma("user_version", { simple: true }), 1);
  assert.equal(db.prepare("SELECT count(*) n FROM a").get().n, 0);
});

test("a database newer than the code is refused", () => {
  const db = openDatabase(":memory:", ["CREATE TABLE a (x)", "CREATE TABLE b (x)"]);
  assert.throws(() => migrate(db, ["CREATE TABLE a (x)"]), /newer than this sparkDash knows/);
});
