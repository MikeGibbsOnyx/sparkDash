// Onyx: the Observer's database (config/sparkdash.db): directory, claim codes, audit.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../../shared/sqlite.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const SPARKDASH_DB_PATH = process.env.SPARKDASH_DB_PATH || path.join(ROOT, "config", "sparkdash.db");

export const MIGRATIONS = [
  `CREATE TABLE people (
     id INTEGER PRIMARY KEY,
     login TEXT NOT NULL UNIQUE COLLATE NOCASE,
     display_name TEXT,
     role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'auditor', 'member')),
     first_seen INTEGER NOT NULL,
     last_seen INTEGER NOT NULL,
     last_device TEXT
   );
   CREATE TABLE groups (
     id INTEGER PRIMARY KEY,
     name TEXT NOT NULL UNIQUE COLLATE NOCASE
   );
   CREATE TABLE group_members (
     group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
     selector TEXT NOT NULL,
     PRIMARY KEY (group_id, selector)
   );
   CREATE TABLE claim_codes (
     hash TEXT PRIMARY KEY,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     used_at INTEGER,
     used_by TEXT
   );
   CREATE TABLE audit (
     id INTEGER PRIMARY KEY,
     ts INTEGER NOT NULL,
     actor TEXT NOT NULL,
     action TEXT NOT NULL,
     target TEXT,
     detail TEXT
   );
   CREATE INDEX audit_ts ON audit(ts);
   CREATE TABLE access_settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   );`,
];

/** @param {string} [file] */
export function openAccessDb(file = SPARKDASH_DB_PATH) {
  return openDatabase(file, MIGRATIONS);
}
