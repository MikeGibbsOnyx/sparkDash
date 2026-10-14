// Onyx Gateway: request logging. Metadata is always recorded; prompt and response content only
// when an Admin turns on full capture. Bodies are gzipped JSON files (0600) in
// gateway-data/bodies/, capped at 2 MB each, kept 7 days by default; metadata 400 days. In
// metadata-only mode nothing is written to bodies/ at all.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

export const BODY_CAP = 2 * 1024 * 1024;
const DAY = 86_400_000;
export const DEFAULT_RETENTION = { bodiesDays: 7, metadataDays: 400 };

/** Headers kept with a request's metadata. Auth headers are never stored. */
export const STORED_HEADERS = ["user-agent", "anthropic-version", "anthropic-beta", "x-claude-code-session-id", "x-claude-code-agent-id"];

export function storedHeaders(h) {
  const out = {};
  for (const k of STORED_HEADERS) if (typeof h?.[k] === "string") out[k] = h[k].slice(0, 500);
  return out;
}

function capText(buf) {
  if (!buf) return { text: null, truncated: false };
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf));
  if (b.length <= BODY_CAP) return { text: b.toString("utf8"), truncated: false };
  return { text: b.subarray(0, BODY_CAP).toString("utf8"), truncated: true };
}

export class CaptureStore {
  /**
   * @param {{ dataDir: string, state: import("../store/state.js").State, db: import("better-sqlite3").Database, now?: () => number, audit?: Function }} deps
   */
  constructor({ dataDir, state, db, now = Date.now, audit }) {
    this.dir = path.join(dataDir, "bodies");
    this.state = state;
    this.db = db;
    this.now = now;
    this.audit = audit || (() => {});
  }

  get mode() {
    return this.state.get("capture_mode", "metadata") === "full" ? "full" : "metadata";
  }

  retention() {
    const r = this.state.get("retention", {}) || {};
    return {
      bodiesDays: Number.isFinite(r.bodiesDays) && r.bodiesDays >= 1 ? r.bodiesDays : DEFAULT_RETENTION.bodiesDays,
      metadataDays: Number.isFinite(r.metadataDays) && r.metadataDays >= 1 ? r.metadataDays : DEFAULT_RETENTION.metadataDays,
    };
  }

  settings() {
    return { mode: this.mode, retention: this.retention() };
  }

  /** Change the capture mode or retention. */
  update({ mode, retention }, actor) {
    if (mode !== undefined) {
      if (mode !== "full" && mode !== "metadata") throw Object.assign(new Error("Capture is either metadata or full."), { status: 400 });
      if (mode !== this.mode) {
        this.state.set("capture_mode", mode);
        this.audit(actor, "capture.mode", null, mode === "full" ? "full capture on" : "metadata only");
      }
    }
    if (retention !== undefined) {
      const cur = this.retention();
      const next = { ...cur };
      for (const k of ["bodiesDays", "metadataDays"]) {
        if (retention[k] === undefined) continue;
        const n = Math.round(Number(retention[k]));
        if (!(n >= 1 && n <= 3650)) throw Object.assign(new Error("Retention is a number of days from 1 to 3,650."), { status: 400 });
        next[k] = n;
      }
      if (next.bodiesDays > next.metadataDays) throw Object.assign(new Error("Content can't be kept longer than the request records it belongs to."), { status: 400 });
      this.state.set("retention", next);
      this.audit(actor, "capture.retention", null, `content ${next.bodiesDays} days, metadata ${next.metadataDays} days`);
    }
    return this.settings();
  }

  /**
   * Store one request's content (full capture only). Returns the relative path, or null.
   * @param {number} id  request id
   * @param {{ request: Buffer | string | null, response: Buffer | null, responseTruncated?: boolean }} c
   */
  write(id, { request, response, responseTruncated = false }) {
    if (this.mode !== "full") return null;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const req = capText(request);
    const res = capText(response);
    const doc = { request: req.text, requestTruncated: req.truncated, response: res.text, responseTruncated: res.truncated || responseTruncated };
    const rel = `bodies/${Number(id)}.json.gz`;
    const file = path.join(this.dir, `${Number(id)}.json.gz`);
    fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(doc)), { mode: 0o600 });
    this.db.prepare("UPDATE requests SET body_path = ? WHERE id = ?").run(rel, id);
    return rel;
  }

  /**
   * Read a request's content. Every read is audited with the reader's name.
   * @returns {{ request: string | null, response: string | null, requestTruncated: boolean, responseTruncated: boolean } | null}
   */
  read(id, actor) {
    const row = this.db.prepare("SELECT id, body_path, identity, model FROM requests WHERE id = ?").get(id);
    if (!row) throw Object.assign(new Error("That request is no longer in the log."), { status: 404 });
    if (!row.body_path) throw Object.assign(new Error("No content was stored for this request (capture was off, or its content has passed retention)."), { status: 404 });
    const file = path.join(this.dir, path.basename(row.body_path));
    let doc;
    try {
      doc = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString("utf8"));
    } catch {
      throw Object.assign(new Error("This request's content file is missing or unreadable."), { status: 404 });
    }
    this.audit(actor, "content.viewed", `request ${row.id}`, `${row.identity}, ${row.model ?? "?"}`);
    return doc;
  }

  /**
   * Delete content and metadata past retention. Runs hourly; returns what it removed.
   * Usage rollups (usage_daily) are kept, so spend history outlives the request log.
   */
  purge() {
    const { bodiesDays, metadataDays } = this.retention();
    const now = this.now();
    let bodies = 0;
    const old = this.db.prepare("SELECT id, body_path FROM requests WHERE body_path IS NOT NULL AND ts < ?").all(now - bodiesDays * DAY);
    for (const r of old) {
      try {
        fs.unlinkSync(path.join(this.dir, path.basename(r.body_path)));
      } catch {
        /* already gone */
      }
      this.db.prepare("UPDATE requests SET body_path = NULL WHERE id = ?").run(r.id);
      bodies++;
    }
    // Stray files (a crash between write and update) older than retention.
    try {
      for (const f of fs.readdirSync(this.dir)) {
        const full = path.join(this.dir, f);
        if (fs.statSync(full).mtimeMs < now - bodiesDays * DAY) {
          fs.unlinkSync(full);
          bodies++;
        }
      }
    } catch {
      /* no bodies directory */
    }
    const metadata = this.db.prepare("DELETE FROM requests WHERE ts < ?").run(now - metadataDays * DAY).changes;
    return { bodies, metadata };
  }
}

const EXPORT_COLUMNS = ["id", "ts", "identity", "via", "device", "client", "provider_id", "model", "format", "stream", "status", "latency_ms", "ttfb_ms", "in_tok", "out_tok", "cache_read_tok", "cache_write_tok", "cost_usd", "cost_basis", "partial", "usage_state", "session_id", "agent_id", "guardrail_hits", "error", "headers"];

/** JSONL of request metadata for a range (never content). */
export function exportJsonl(db, { from = 0, to = Date.now(), limit = 200_000 } = {}) {
  const rows = db.prepare(`SELECT ${EXPORT_COLUMNS.join(", ")} FROM requests WHERE ts >= ? AND ts < ? ORDER BY id LIMIT ?`).all(from, to, limit);
  return rows
    .map((r) => {
      const o = { ...r, time: new Date(r.ts).toISOString() };
      for (const k of ["guardrail_hits", "headers"]) if (typeof o[k] === "string") o[k] = JSON.parse(o[k]);
      return JSON.stringify(o);
    })
    .join("\n") + (rows.length ? "\n" : "");
}

/**
 * The Requests tab: newest first, with filters. Content is never included here.
 * @param {{ before?: number, limit?: number, identity?: string, model?: string, status?: string, range?: string }} q
 */
export function listRequests(db, q = {}) {
  const where = [];
  const args = [];
  if (q.before) (where.push("id < ?"), args.push(Number(q.before)));
  if (q.identity) (where.push("identity = ?"), args.push(String(q.identity)));
  if (q.model) (where.push("model = ?"), args.push(String(q.model)));
  if (q.status === "ok") where.push("status < 400 AND error IS NULL");
  else if (q.status === "error") where.push("(status >= 400 OR error IS NOT NULL) AND coalesce(usage_state, '') NOT IN ('blocked', 'refused')");
  else if (q.status === "blocked") where.push("usage_state = 'blocked'");
  else if (q.status === "refused") where.push("usage_state = 'refused'");
  else if (q.status === "flagged") where.push("guardrail_hits IS NOT NULL");
  const span = { "24h": DAY, "7d": 7 * DAY, "30d": 30 * DAY }[q.range];
  if (span) (where.push("ts >= ?"), args.push(Date.now() - span));
  const limit = Math.min(500, Math.max(1, Number(q.limit) || 100));
  const rows = db
    .prepare(
      `SELECT id, ts, identity, via, device, client, provider_id AS providerId, model, format, stream, status, latency_ms AS latencyMs, ttfb_ms AS ttfbMs,
              in_tok AS inTok, out_tok AS outTok, cache_read_tok AS cacheReadTok, cache_write_tok AS cacheWriteTok, cost_usd AS costUsd, cost_basis AS costBasis,
              partial, usage_state AS usageState, session_id AS sessionId, agent_id AS agentId, guardrail_hits AS guardrailHits, error, headers,
              body_path IS NOT NULL AS hasContent
         FROM requests ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`
    )
    .all(...args, limit)
    .map((r) => ({ ...r, stream: Boolean(r.stream), partial: Boolean(r.partial), hasContent: Boolean(r.hasContent), guardrailHits: r.guardrailHits ? JSON.parse(r.guardrailHits) : [], headers: r.headers ? JSON.parse(r.headers) : {} }));
  return { requests: rows, more: rows.length === limit };
}
