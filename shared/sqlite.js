// Onyx: shared SQLite helpers for the Observer and the Gateway.
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

/**
 * Open (or create) a SQLite database in WAL mode and bring it to the latest schema.
 *
 * `migrations` is an ordered list of SQL strings or `(db) => void` functions; entry i is
 * schema version i + 1. Each pending migration runs in its own transaction, and
 * `PRAGMA user_version` records how far the database has got, so a crash mid-way
 * resumes at the failed step. A database newer than the code is refused rather than
 * guessed at.
 *
 * @param {string} file Database path, or ":memory:".
 * @param {Array<string | ((db: import("better-sqlite3").Database) => void)>} migrations
 * @returns {import("better-sqlite3").Database}
 */
export function openDatabase(file, migrations) {
  if (file !== ":memory:") {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Create the file 0600 before SQLite does, so it never exists world-readable.
    if (!fs.existsSync(file)) fs.closeSync(fs.openSync(file, "a", 0o600));
  }
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db, migrations);
  return db;
}

/** Apply pending migrations. Exported for tests. */
export function migrate(db, migrations) {
  const current = db.pragma("user_version", { simple: true });
  if (current > migrations.length) {
    throw new Error(
      `Database schema version ${current} is newer than this sparkDash knows (${migrations.length}). Upgrade sparkDash or restore a matching backup.`
    );
  }
  for (let version = current + 1; version <= migrations.length; version++) {
    const step = migrations[version - 1];
    db.transaction(() => {
      if (typeof step === "function") step(db);
      else db.exec(step);
      db.pragma(`user_version = ${version}`);
    })();
  }
  return db.pragma("user_version", { simple: true });
}
