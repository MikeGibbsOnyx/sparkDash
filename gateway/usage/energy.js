// Onyx Gateway: the energy cost of requests to local models. Each minute the Observer sends each
// machine's measured energy (Wh), the tokens its model servers processed, and the electricity
// rate. That minute's cost is split across the Gateway's requests on that machine by token share;
// tokens the Gateway didn't see (direct use) and idle minutes stay unattributed. Estimates.
import { machineSlug } from "../providers/registry.js";

const MINUTE_MS = 60_000;
/** A minute is settled this long after it ends, once no request on its machine is still running. */
const SETTLE_AFTER_MS = 20_000;
/** ...but never later than this, even under a request that runs on and on. */
const SETTLE_AT_MOST_MS = 15 * MINUTE_MS;
const KEEP_MS = 31 * 24 * 60 * MINUTE_MS;

/** Tokens a request processed, for the share: everything it read and wrote. */
function processed(r) {
  return (r.in_tok ?? 0) + (r.out_tok ?? 0) + (r.cache_read_tok ?? 0) + (r.cache_write_tok ?? 0);
}

/**
 * Split one machine-minute's cost across requests. Pure, for tests.
 * Each request's tokens are spread evenly over its own duration; its share of the minute is the
 * part of those tokens that fall inside it, over the larger of the server's count and the Gateway's
 * own (counters are sampled, so the Gateway's count can run ahead of the server's).
 * @param {{ minute: number, costUsd: number, serverTokens: number }} m
 * @param {Array<{ id: number, ts: number, end_ts: number, tokens: number }>} reqs
 * @returns {{ shares: Map<number, number>, gatewayTokens: number, attributedUsd: number }}
 */
export function allocateMinute(m, reqs) {
  const lo = m.minute;
  const hi = m.minute + MINUTE_MS;
  const inMinute = new Map();
  let gw = 0;
  for (const r of reqs) {
    const start = r.ts;
    const end = Math.max(r.end_ts ?? r.ts, r.ts + 1);
    const overlap = Math.min(end, hi) - Math.max(start, lo);
    if (overlap <= 0 || !(r.tokens > 0)) continue;
    const t = (r.tokens * overlap) / (end - start);
    inMinute.set(r.id, t);
    gw += t;
  }
  const shares = new Map();
  const denom = Math.max(m.serverTokens || 0, gw);
  let attributed = 0;
  if (denom > 0 && m.costUsd > 0) {
    for (const [id, t] of inMinute) {
      const usd = (m.costUsd * t) / denom;
      shares.set(id, usd);
      attributed += usd;
    }
  }
  return { shares, gatewayTokens: gw, attributedUsd: attributed };
}

export class Energy {
  /**
   * @param {import("better-sqlite3").Database} db
   * @param {{ now?: () => number, usage: import("./ledger.js").Usage, onCost?: (row: object, usd: number) => void }} deps
   */
  constructor(db, { now = Date.now, usage, onCost }) {
    this.db = db;
    this.now = now;
    this.usage = usage;
    this.onCost = onCost || (() => {});
  }

  /**
   * Store minutes pushed by the Observer (idempotent: a minute sent twice is kept once, and a
   * settled minute is never changed).
   * @param {{ rate: number | null, minutes: Array<{ machine: string, minute: number, wh: number, serverTokens?: number }> }} push
   */
  ingest({ rate, minutes }) {
    const r = Number.isFinite(rate) && rate >= 0 ? rate : null;
    const up = this.db.prepare(
      `INSERT INTO energy_minutes (machine, minute, wh, rate, server_tokens) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (machine, minute) DO UPDATE SET wh = excluded.wh, rate = excluded.rate, server_tokens = excluded.server_tokens
       WHERE energy_minutes.settled = 0`
    );
    let n = 0;
    this.db.transaction(() => {
      for (const m of Array.isArray(minutes) ? minutes : []) {
        const minute = Math.floor(Number(m.minute) / MINUTE_MS) * MINUTE_MS;
        const wh = Number(m.wh);
        if (!m.machine || !Number.isFinite(minute) || !(wh >= 0) || wh > 1000) continue;
        up.run(machineSlug(m.machine), minute, wh, r, Math.max(0, Math.round(Number(m.serverTokens) || 0)));
        n++;
      }
    })();
    return n;
  }

  /** Settle every minute that is ready. Returns how many were settled. */
  settle() {
    const now = this.now();
    const due = this.db.prepare("SELECT * FROM energy_minutes WHERE settled = 0 AND minute <= ? ORDER BY minute").all(now - MINUTE_MS - SETTLE_AFTER_MS);
    let n = 0;
    for (const m of due) {
      const prefix = `local-${m.machine}:`;
      const end = m.minute + MINUTE_MS;
      if (this.usage.busy(prefix, end) && now - end < SETTLE_AT_MOST_MS) continue;
      const rows = this.db
        .prepare(
          `SELECT id, ts, end_ts, identity, kind, key_name, groups, in_tok, out_tok, cache_read_tok, cache_write_tok FROM requests
            WHERE cost_basis = 'local' AND provider_id >= ? AND provider_id < ? AND end_ts > ? AND ts < ?`
        )
        .all(prefix, `${prefix}￿`, m.minute, end);
      const costUsd = m.rate == null ? null : (m.wh / 1000) * m.rate;
      const { shares, gatewayTokens, attributedUsd } = allocateMinute({ minute: m.minute, costUsd: costUsd ?? 0, serverTokens: m.server_tokens }, rows.map((r) => ({ ...r, tokens: processed(r) })));
      this.db.transaction(() => {
        for (const [id, usd] of shares) {
          this.usage.addCost(id, usd);
          const row = rows.find((r) => r.id === id);
          this.onCost(row, usd);
        }
        this.db
          .prepare("UPDATE energy_minutes SET settled = 1, gateway_tokens = ?, cost_usd = ?, attributed_usd = ? WHERE machine = ? AND minute = ?")
          .run(gatewayTokens, costUsd, costUsd == null ? null : attributedUsd, m.machine, m.minute);
      })();
      n++;
    }
    this.db.prepare("DELETE FROM energy_minutes WHERE minute < ?").run(now - KEEP_MS);
    return n;
  }

  /** Local energy cost for a range: attributed to Gateway requests, and unattributed. */
  summary(sinceMs) {
    const t = this.db
      .prepare(
        `SELECT coalesce(sum(wh), 0) AS wh, coalesce(sum(cost_usd), 0) AS costUsd, coalesce(sum(attributed_usd), 0) AS attributedUsd,
                sum(CASE WHEN settled = 1 AND cost_usd IS NULL THEN 1 ELSE 0 END) AS minutesWithoutRate,
                sum(CASE WHEN settled = 0 THEN 1 ELSE 0 END) AS pendingMinutes,
                max(minute) AS lastMinute
           FROM energy_minutes WHERE minute >= ?`
      )
      .get(sinceMs);
    const byMachine = this.db
      .prepare(
        `SELECT machine, coalesce(sum(wh), 0) AS wh, coalesce(sum(cost_usd), 0) AS costUsd, coalesce(sum(attributed_usd), 0) AS attributedUsd,
                coalesce(sum(server_tokens), 0) AS serverTokens, coalesce(sum(gateway_tokens), 0) AS gatewayTokens
           FROM energy_minutes WHERE minute >= ? GROUP BY machine ORDER BY costUsd DESC`
      )
      .all(sinceMs)
      .map((r) => ({ ...r, unattributedUsd: Math.max(0, r.costUsd - r.attributedUsd) }));
    const rate = this.db.prepare("SELECT rate FROM energy_minutes ORDER BY minute DESC LIMIT 1").get()?.rate ?? null;
    return { ...t, unattributedUsd: Math.max(0, t.costUsd - t.attributedUsd), rate, byMachine, estimated: true };
  }
}
