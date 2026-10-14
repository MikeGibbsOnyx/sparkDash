// Onyx Gateway: budgets. Before a request is forwarded, the period's spend plus every in-flight
// reservation (each reserves its max output tokens at the output price) must stay within each
// budget that applies to the caller; at most 8 requests per identity may be in flight while a
// budget applies. Subscription requests count toward token budgets only.
import { periodBounds, resetLabel, safeZone } from "../usage/periods.js";

export const MAX_IN_FLIGHT = 8;
export const DEFAULT_MAX_OUTPUT = 4096;
const PERIODS = ["day", "week", "month"];

/** Output-token ceiling the client asked for, per format; 4,096 when it didn't say. */
export function requestedMaxOutput(format, body) {
  const b = body && typeof body === "object" ? body : {};
  const v =
    format === "anthropic"
      ? b.max_tokens
      : format === "openai-responses"
        ? b.max_output_tokens
        : format === "gemini"
          ? b.generationConfig?.maxOutputTokens
          : (b.max_completion_tokens ?? b.max_tokens);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_MAX_OUTPUT;
}

/**
 * Does a budget's scope cover a caller? `subject` is who budgets see: { kind, login, keyName, groups }.
 * Scopes: "everyone", "person:<login>", "group:<name>", "key:<name>".
 */
export function scopeMatches(scope, subject) {
  const s = String(scope || "");
  const eq = (a, b) => Boolean(a) && Boolean(b) && String(a).toLowerCase() === String(b).toLowerCase();
  if (s === "everyone") return true;
  if (s.startsWith("person:")) return subject.kind === "person" && eq(subject.login, s.slice(7));
  if (s.startsWith("group:")) return (subject.groups || []).some((g) => eq(g, s.slice(6)));
  if (s.startsWith("key:")) return eq(subject.keyName, s.slice(4));
  return false;
}

/** The same test in SQL, over the requests table (alias r). */
function scopeSql(scope) {
  const s = String(scope || "");
  if (s === "everyone") return { sql: "1", args: [] };
  if (s.startsWith("person:")) return { sql: "r.kind = 'person' AND lower(r.identity) = lower(?)", args: [s.slice(7)] };
  if (s.startsWith("group:")) return { sql: "EXISTS (SELECT 1 FROM json_each(r.groups) g WHERE lower(g.value) = lower(?))", args: [s.slice(6)] };
  if (s.startsWith("key:")) return { sql: "lower(r.key_name) = lower(?)", args: [s.slice(4)] };
  return { sql: "0", args: [] };
}

const usd = (n) => `$${(Math.round(n * 100) / 100).toFixed(2)}`;
const toks = (n) => Math.round(n).toLocaleString("en-US");

export class BudgetError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export class Budgets {
  /**
   * @param {import("better-sqlite3").Database} db
   * @param {{ now?: () => number, audit?: Function, timeZone?: () => string }} [opts]
   */
  constructor(db, { now = Date.now, audit, timeZone = () => "UTC" } = {}) {
    this.db = db;
    this.now = now;
    this.audit = audit || (() => {});
    this.timeZone = () => safeZone(timeZone());
    /** budget id -> { key, usd, tokens }: spend this period, kept current as requests finish. */
    this.spent = new Map();
    /** ticket -> { label, budgets: number[], usd, tokens } */
    this.inflight = new Map();
    this._ticket = 1;
  }

  // ─── Admin ──────────────────────────────────────────────
  list() {
    const now = this.now();
    return this.db.prepare("SELECT * FROM budgets ORDER BY id").all().map((b) => {
      const s = this.#spend(b, now);
      const bounds = periodBounds(b.period, now, this.timeZone());
      return {
        id: b.id,
        name: b.name,
        scope: b.scope,
        period: b.period,
        limitUsd: b.limit_usd,
        limitTokens: b.limit_tokens,
        warnPct: b.warn_pct,
        spentUsd: s.usd,
        spentTokens: s.tokens,
        inFlightUsd: this.#inflightFor(b.id).usd,
        periodStart: bounds.start,
        resetsAt: bounds.end,
        resets: resetLabel(b.period, now, this.timeZone()),
        state: this.#state(b, s),
        updatedBy: b.updated_by,
        updatedAt: b.updated_at,
      };
    });
  }

  #validate(b) {
    const name = String(b.name || "").trim().slice(0, 80);
    if (!name) throw new BudgetError(400, "Give the budget a name.");
    const scope = String(b.scope || "").trim();
    if (!(scope === "everyone" || /^(person|group|key):.+/.test(scope))) throw new BudgetError(400, "Choose who the budget covers: everyone, a person, a group or a gateway key.");
    const period = String(b.period || "");
    if (!PERIODS.includes(period)) throw new BudgetError(400, "The period must be day, week or month.");
    const limitUsd = b.limitUsd == null || b.limitUsd === "" ? null : Number(b.limitUsd);
    const limitTokens = b.limitTokens == null || b.limitTokens === "" ? null : Math.floor(Number(b.limitTokens));
    if (limitUsd == null && limitTokens == null) throw new BudgetError(400, "Set a limit in USD or in tokens.");
    if (limitUsd != null && !(Number.isFinite(limitUsd) && limitUsd >= 0)) throw new BudgetError(400, "The USD limit must be a number of dollars, 0 or more.");
    if (limitTokens != null && !(Number.isFinite(limitTokens) && limitTokens >= 0)) throw new BudgetError(400, "The token limit must be a whole number, 0 or more.");
    const warnPct = b.warnPct == null || b.warnPct === "" ? 80 : Math.round(Number(b.warnPct));
    if (!(warnPct >= 1 && warnPct <= 100)) throw new BudgetError(400, "The warning must be between 1% and 100%.");
    return { name, scope, period, limitUsd, limitTokens, warnPct };
  }

  create(b, actor) {
    const v = this.#validate(b);
    const id = Number(
      this.db
        .prepare("INSERT INTO budgets (name, scope, period, limit_usd, limit_tokens, warn_pct, created_by, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(v.name, v.scope, v.period, v.limitUsd, v.limitTokens, v.warnPct, actor, actor, this.now()).lastInsertRowid
    );
    this.audit(actor, "budget.created", v.name, describe(v));
    return this.list().find((x) => x.id === id);
  }

  update(id, b, actor) {
    const old = this.db.prepare("SELECT * FROM budgets WHERE id = ?").get(id);
    if (!old) throw new BudgetError(404, "That budget no longer exists.");
    const v = this.#validate({ name: old.name, scope: old.scope, period: old.period, limitUsd: old.limit_usd, limitTokens: old.limit_tokens, warnPct: old.warn_pct, ...b });
    this.db
      .prepare("UPDATE budgets SET name = ?, scope = ?, period = ?, limit_usd = ?, limit_tokens = ?, warn_pct = ?, updated_by = ?, updated_at = ?, warned_period = NULL, exhausted_period = NULL WHERE id = ?")
      .run(v.name, v.scope, v.period, v.limitUsd, v.limitTokens, v.warnPct, actor, this.now(), id);
    this.spent.delete(id);
    this.audit(actor, "budget.changed", v.name, describe(v));
    return this.list().find((x) => x.id === id);
  }

  remove(id, actor) {
    const old = this.db.prepare("SELECT * FROM budgets WHERE id = ?").get(id);
    if (!old) throw new BudgetError(404, "That budget no longer exists.");
    this.db.prepare("DELETE FROM budgets WHERE id = ?").run(id);
    this.spent.delete(id);
    this.audit(actor, "budget.removed", old.name, null);
  }

  /** Re-read every budget's spend from the request log (after a time zone change, say). */
  reset() {
    this.spent.clear();
  }

  // ─── Spend ──────────────────────────────────────────────
  #spend(b, now) {
    const { start, key } = periodBounds(b.period, now, this.timeZone());
    const cached = this.spent.get(b.id);
    if (cached && cached.key === key) return cached;
    const { sql, args } = scopeSql(b.scope);
    const row = this.db
      .prepare(
        `SELECT coalesce(sum(CASE WHEN r.cost_basis = 'subscription' THEN 0 ELSE r.cost_usd END), 0) AS usd,
                coalesce(sum(coalesce(r.in_tok, 0) + coalesce(r.out_tok, 0) + coalesce(r.cache_read_tok, 0) + coalesce(r.cache_write_tok, 0)), 0) AS tokens
           FROM requests r WHERE r.ts >= ? AND ${sql}`
      )
      .get(start, ...args);
    const fresh = { key, usd: row.usd, tokens: row.tokens };
    this.spent.set(b.id, fresh);
    return fresh;
  }

  #inflightFor(id) {
    let u = 0;
    let t = 0;
    for (const f of this.inflight.values()) {
      if (f.budgets.includes(id)) {
        u += f.usd;
        t += f.tokens;
      }
    }
    return { usd: u, tokens: t };
  }

  #state(b, s) {
    const over = (b.limit_usd != null && s.usd >= b.limit_usd) || (b.limit_tokens != null && s.tokens >= b.limit_tokens);
    if (over) return "exhausted";
    const warn = (b.limit_usd != null && b.limit_usd > 0 && s.usd >= (b.limit_usd * b.warn_pct) / 100) || (b.limit_tokens != null && b.limit_tokens > 0 && s.tokens >= (b.limit_tokens * b.warn_pct) / 100);
    return warn ? "warning" : "ok";
  }

  /** The budgets that cover a caller, with this period's spend (the Connect page). */
  forSubject(subject) {
    const mine = new Set(this.applicable(subject).map((b) => b.id));
    return this.list().filter((b) => mine.has(b.id));
  }

  applicable(subject) {
    return this.db.prepare("SELECT * FROM budgets ORDER BY id").all().filter((b) => scopeMatches(b.scope, subject));
  }

  // ─── Admission ──────────────────────────────────────────
  /**
   * Reserve room for a request, or refuse it.
   * @param {{ subject: object, label: string, costBasis: "key" | "subscription" | "local", priceOut: number | null, maxOutput: number }} r
   * @returns {{ ok: true, ticket: number | null } | { ok: false, status: number, message: string, retryable: boolean }}
   */
  admit({ subject, label, costBasis, priceOut, maxOutput }) {
    const budgets = this.applicable(subject);
    if (!budgets.length) return { ok: true, ticket: null };
    let mine = 0;
    for (const f of this.inflight.values()) if (f.label === label) mine++;
    if (mine >= MAX_IN_FLIGHT) {
      return { ok: false, status: 429, retryable: true, message: `${label} already has ${MAX_IN_FLIGHT} requests in progress, the most allowed while a budget applies. Wait for one to finish.` };
    }
    const now = this.now();
    const tz = this.timeZone();
    // Subscription and local requests have no dollar price up front; local energy cost is added once it settles.
    const reserveUsd = costBasis === "key" && priceOut ? (maxOutput * priceOut) / 1e6 : 0;
    const reserveTokens = maxOutput;
    for (const b of budgets) {
      const s = this.#spend(b, now);
      const f = this.#inflightFor(b.id);
      const resets = resetLabel(b.period, now, tz);
      const usdLimited = b.limit_usd != null && costBasis !== "subscription";
      if (usdLimited && s.usd >= b.limit_usd) return this.#refuse(b, `Budget '${b.name}' used: ${usd(s.usd)} of ${usd(b.limit_usd)}. Resets ${resets}.`);
      if (b.limit_tokens != null && s.tokens >= b.limit_tokens) return this.#refuse(b, `Budget '${b.name}' used: ${toks(s.tokens)} of ${toks(b.limit_tokens)} tokens. Resets ${resets}.`);
      if (usdLimited && s.usd + f.usd + reserveUsd > b.limit_usd) {
        const left = Math.max(0, b.limit_usd - s.usd - f.usd);
        return this.#refuse(b, `Budget '${b.name}' has ${usd(left)} left of ${usd(b.limit_usd)}${f.usd ? " after requests in progress" : ""}, less than this request could cost (${usd(reserveUsd)} for up to ${toks(maxOutput)} output tokens). Ask for fewer output tokens, or wait until it resets ${resets}.`, false);
      }
      if (b.limit_tokens != null && s.tokens + f.tokens + reserveTokens > b.limit_tokens) {
        const left = Math.max(0, b.limit_tokens - s.tokens - f.tokens);
        return this.#refuse(b, `Budget '${b.name}' has ${toks(left)} tokens left of ${toks(b.limit_tokens)}${f.tokens ? " after requests in progress" : ""}, fewer than this request could use (up to ${toks(maxOutput)} output tokens). Ask for fewer output tokens, or wait until it resets ${resets}.`, false);
      }
    }
    const ticket = this._ticket++;
    this.inflight.set(ticket, { label, budgets: budgets.map((b) => b.id), usd: reserveUsd, tokens: reserveTokens });
    return { ok: true, ticket };
  }

  #refuse(b, message, exhausted = true) {
    if (exhausted) this.#markExhausted(b);
    return { ok: false, status: 429, retryable: false, message };
  }

  release(ticket) {
    if (ticket != null) this.inflight.delete(ticket);
  }

  // ─── Spend arriving ─────────────────────────────────────
  /**
   * A request finished (or a local request's energy cost settled): add it to every matching
   * budget's spend for the period it started in, and raise warning or exhaustion events once.
   */
  add(subject, ts, { usd: dollars = 0, tokens = 0, costBasis }) {
    const now = this.now();
    const tz = this.timeZone();
    for (const b of this.applicable(subject)) {
      const cached = this.spent.get(b.id);
      const s = this.#spend(b, now);
      if (periodBounds(b.period, ts, tz).key !== s.key) continue;
      // A cold cache was just read from the request log, which already holds this spend.
      if (cached === s) {
        if (costBasis !== "subscription") s.usd += dollars || 0;
        s.tokens += tokens || 0;
      }
      const state = this.#state(b, s);
      if (state === "exhausted") this.#markExhausted(b);
      else if (state === "warning" && b.warned_period !== s.key) {
        this.db.prepare("UPDATE budgets SET warned_period = ? WHERE id = ?").run(s.key, b.id);
        this.audit("sparkDash", "budget.warning", b.name, `${b.limit_usd != null ? `${usd(s.usd)} of ${usd(b.limit_usd)}` : `${toks(s.tokens)} of ${toks(b.limit_tokens)} tokens`}`);
      }
    }
  }

  #markExhausted(b) {
    const key = periodBounds(b.period, this.now(), this.timeZone()).key;
    if (b.exhausted_period === key) return;
    this.db.prepare("UPDATE budgets SET exhausted_period = ? WHERE id = ?").run(key, b.id);
    b.exhausted_period = key;
    this.audit("sparkDash", "budget.exhausted", b.name, `resets ${resetLabel(b.period, this.now(), this.timeZone())}`);
  }

  /** Budgets past their warning level this period: health findings. */
  findings() {
    return this.list()
      .filter((b) => b.state !== "ok")
      .map((b) => ({
        id: `budget-${b.state}:${b.id}`,
        severity: b.state === "exhausted" ? "warn" : "info",
        title: b.state === "exhausted" ? `Budget ${b.name} is used up` : `Budget ${b.name} is past ${b.warnPct}%`,
        detail: b.limitUsd != null ? `${usd(b.spentUsd)} of ${usd(b.limitUsd)}` : `${toks(b.spentTokens)} of ${toks(b.limitTokens)} tokens`,
        hint: `Requests it covers are refused until it resets ${b.resets}, or an Admin raises it on the Access tab.`,
      }));
  }
}

function describe(v) {
  const limits = [v.limitUsd != null ? usd(v.limitUsd) : null, v.limitTokens != null ? `${toks(v.limitTokens)} tokens` : null].filter(Boolean).join(" and ");
  return `${v.scope}, ${limits} a ${v.period}`;
}
