// Onyx Gateway: gateway-data/gateway.db. Only the Gateway opens it; the Observer never mounts it.
import path from "node:path";
import { openDatabase } from "../../shared/sqlite.js";

export const MIGRATIONS = [
  `CREATE TABLE settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   );
   -- Snapshot pushed by the Observer: people and groups.
   CREATE TABLE directory (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     snapshot TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE providers (
     id TEXT PRIMARY KEY,
     type TEXT NOT NULL,
     name TEXT NOT NULL,
     base_url TEXT NOT NULL,
     options TEXT NOT NULL DEFAULT '{}',
     own_login INTEGER NOT NULL DEFAULT 0,
     enabled INTEGER NOT NULL DEFAULT 1,
     status TEXT NOT NULL DEFAULT 'not_tested',
     last_error TEXT,
     last_tested_at INTEGER,
     key_last4 TEXT,
     key_source TEXT NOT NULL DEFAULT 'saved',
     added_by TEXT,
     added_at INTEGER NOT NULL,
     last_used_at INTEGER
   );
   CREATE TABLE provider_secrets (
     provider_id TEXT PRIMARY KEY REFERENCES providers(id) ON DELETE CASCADE,
     ciphertext TEXT NOT NULL
   );
   CREATE TABLE models (
     id INTEGER PRIMARY KEY,
     provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     upstream_name TEXT NOT NULL,
     enabled INTEGER NOT NULL DEFAULT 1,
     price_in REAL,
     price_out REAL,
     price_cache_read REAL,
     price_cache_write REAL,
     UNIQUE (provider_id, name)
   );
   -- Inventory pushed by the Observer: local model servers it detected.
   CREATE TABLE local_servers (
     id TEXT PRIMARY KEY,
     machine TEXT NOT NULL,
     address TEXT NOT NULL,
     port INTEGER NOT NULL,
     backend TEXT,
     models TEXT NOT NULL DEFAULT '[]',
     api_key_ciphertext TEXT,
     reachable INTEGER NOT NULL DEFAULT 1,
     up INTEGER NOT NULL DEFAULT 0,
     serve INTEGER NOT NULL DEFAULT 0,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE grants (
     id INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     selectors TEXT NOT NULL,
     model_patterns TEXT NOT NULL,
     mcp_patterns TEXT NOT NULL DEFAULT '[]',
     updated_by TEXT,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE gateway_keys (
     id INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     prefix TEXT NOT NULL,
     hash TEXT NOT NULL UNIQUE,
     acts_as TEXT,
     access TEXT,
     created_by TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     expires_at INTEGER,
     last_used_at INTEGER,
     last_used_from TEXT,
     revoked_at INTEGER,
     expiry_warned_at INTEGER
   );
   CREATE TABLE requests (
     id INTEGER PRIMARY KEY,
     ts INTEGER NOT NULL,
     identity TEXT NOT NULL,
     via TEXT NOT NULL,
     device TEXT,
     client TEXT,
     provider_id TEXT,
     model TEXT,
     format TEXT,
     stream INTEGER NOT NULL DEFAULT 0,
     status INTEGER,
     latency_ms INTEGER,
     ttfb_ms INTEGER,
     in_tok INTEGER,
     out_tok INTEGER,
     cache_read_tok INTEGER,
     cache_write_tok INTEGER,
     cost_usd REAL,
     cost_basis TEXT,
     price_snapshot TEXT,
     partial INTEGER NOT NULL DEFAULT 0,
     session_id TEXT,
     agent_id TEXT,
     guardrail_hits TEXT,
     error TEXT,
     body_path TEXT
   );
   CREATE INDEX requests_ts ON requests(ts);
   CREATE INDEX requests_identity_ts ON requests(identity, ts);
   CREATE INDEX requests_provider_ts ON requests(provider_id, ts);
   CREATE TABLE audit (
     id INTEGER PRIMARY KEY,
     ts INTEGER NOT NULL,
     actor TEXT NOT NULL,
     action TEXT NOT NULL,
     target TEXT,
     detail TEXT
   );`,
];

export function openGatewayDb(dataDir) {
  return openDatabase(dataDir === ":memory:" ? ":memory:" : path.join(dataDir, "gateway.db"), MIGRATIONS);
}
