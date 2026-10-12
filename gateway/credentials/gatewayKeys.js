// Onyx Gateway: gateway keys for callers Tailscale can't identify (CI runners, tagged
// servers, personal tools off the tailnet). Shown once; only a SHA-256 hash is stored.
import crypto from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const DAY = 24 * 60 * 60 * 1000;
export const EXPIRY_CHOICES = { 30: 30 * DAY, 90: 90 * DAY, 365: 365 * DAY, never: null };
export const WARN_BEFORE_MS = 7 * DAY;

export function hashKey(key) {
  return crypto.createHash("sha256").update(String(key)).digest("hex");
}

export function isGatewayKey(value) {
  return /^sdgw_[0-9A-Za-z]{32}$/.test(String(value || ""));
}

function newKey() {
  let s = "";
  // Rejection sampling keeps every character equally likely.
  while (s.length < 32) {
    for (const b of crypto.randomBytes(48)) {
      if (b < 248 && s.length < 32) s += ALPHABET[b % 62];
    }
  }
  return `sdgw_${s}`;
}

export class GatewayKeys {
  /**
   * @param {import("better-sqlite3").Database} db
   * @param {{ now?: () => number, audit: (actor: string, action: string, target: string, detail?: string) => void }} opts
   */
  constructor(db, opts) {
    this.db = db;
    this.now = opts.now || Date.now;
    this.audit = opts.audit;
  }

  /**
   * @param {{ name: string, access?: string | null, actsAs?: string | null, expiry?: keyof typeof EXPIRY_CHOICES | string, createdBy: string }} input
   * @returns {{ key: string, record: object }} The key itself is returned here and never again.
   */
  create({ name, access = null, actsAs = null, expiry = "90", createdBy }) {
    const clean = String(name || "").trim();
    if (!/^[a-z0-9][a-z0-9_.-]{0,39}$/i.test(clean)) throw Object.assign(new Error("Key names are 1–40 letters, numbers, dots, dashes or underscores, like ci-deploy."), { status: 400 });
    if (!(String(expiry) in EXPIRY_CHOICES)) throw Object.assign(new Error("Expiry must be 30 days, 90 days, 1 year or never."), { status: 400 });
    if (this.db.prepare("SELECT 1 FROM gateway_keys WHERE name = ? AND revoked_at IS NULL").get(clean)) {
      throw Object.assign(new Error(`A key called ${clean} already exists. Pick another name or revoke the old one.`), { status: 409 });
    }
    const key = newKey();
    const now = this.now();
    const ttl = EXPIRY_CHOICES[String(expiry)];
    const id = this.db
      .prepare("INSERT INTO gateway_keys (name, prefix, hash, acts_as, access, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(clean, key.slice(0, 12), hashKey(key), actsAs, access, createdBy, now, ttl == null ? null : now + ttl).lastInsertRowid;
    this.audit(createdBy, "key.created", clean, actsAs ? `personal key for ${actsAs}` : `access ${access || "default"}`);
    return { key, record: this.get(Number(id)) };
  }

  get(id) {
    const row = this.db.prepare("SELECT * FROM gateway_keys WHERE id = ?").get(id);
    return row ? this.present(row) : null;
  }

  /** The list never includes hashes. */
  list({ actsAs } = {}) {
    const rows = actsAs
      ? this.db.prepare("SELECT * FROM gateway_keys WHERE acts_as = ? AND revoked_at IS NULL ORDER BY created_at DESC").all(actsAs)
      : this.db.prepare("SELECT * FROM gateway_keys ORDER BY revoked_at IS NOT NULL, created_at DESC").all();
    return rows.map((r) => this.present(r));
  }

  present(r) {
    const now = this.now();
    return {
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      actsAs: r.acts_as,
      access: r.access,
      createdBy: r.created_by,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      lastUsedAt: r.last_used_at,
      lastUsedFrom: r.last_used_from,
      revokedAt: r.revoked_at,
      state: r.revoked_at ? "revoked" : r.expires_at != null && r.expires_at <= now ? "expired" : r.expires_at != null && r.expires_at - now <= WARN_BEFORE_MS ? "expiring" : "active",
    };
  }

  /**
   * Look up a presented key. Revocation and expiry apply to the very next request.
   * @returns {{ ok: true, key: object } | { ok: false, error: string, fix: string } | null} null: not a gateway key at all.
   */
  verify(presented, from) {
    if (!isGatewayKey(presented)) return null;
    const row = this.db.prepare("SELECT * FROM gateway_keys WHERE hash = ?").get(hashKey(presented));
    if (!row) return { ok: false, error: "That gateway key isn't valid.", fix: "Check you copied the whole key, or ask an Admin for a new one." };
    if (row.revoked_at) return { ok: false, error: `Gateway key ${row.name} was revoked.`, fix: "Ask an Admin for a new key." };
    const now = this.now();
    if (row.expires_at != null && row.expires_at <= now) return { ok: false, error: `Gateway key ${row.name} expired on ${new Date(row.expires_at).toISOString().slice(0, 10)}.`, fix: "Ask an Admin for a new key." };
    // A minute's resolution is enough for "last used"; don't write on every request.
    if (!row.last_used_at || now - row.last_used_at > 60_000 || row.last_used_from !== from) {
      this.db.prepare("UPDATE gateway_keys SET last_used_at = ?, last_used_from = ? WHERE id = ?").run(now, from || null, row.id);
    }
    return { ok: true, key: this.present(row) };
  }

  revoke(id, actor, { onlyActsAs } = {}) {
    const row = this.db.prepare("SELECT * FROM gateway_keys WHERE id = ?").get(id);
    if (!row || (onlyActsAs && row.acts_as !== onlyActsAs)) throw Object.assign(new Error("That key doesn't exist."), { status: 404 });
    if (row.revoked_at) return this.present(row);
    this.db.prepare("UPDATE gateway_keys SET revoked_at = ? WHERE id = ?").run(this.now(), id);
    this.audit(actor, "key.revoked", row.name, row.acts_as ? `personal key for ${row.acts_as}` : null);
    return this.get(id);
  }

  /** Keys expiring within 7 days that haven't been announced yet; marks them announced. */
  takeExpiryWarnings() {
    const now = this.now();
    const rows = this.db
      .prepare("SELECT * FROM gateway_keys WHERE revoked_at IS NULL AND expiry_warned_at IS NULL AND expires_at IS NOT NULL AND expires_at > ? AND expires_at - ? <= ?")
      .all(now, now, WARN_BEFORE_MS);
    for (const r of rows) {
      this.db.prepare("UPDATE gateway_keys SET expiry_warned_at = ? WHERE id = ?").run(now, r.id);
      this.audit("sparkDash", "key.expiring", r.name, new Date(r.expires_at).toISOString());
    }
    return rows.map((r) => this.present(r));
  }
}
