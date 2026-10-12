// Onyx: one-time claim codes that make the first remote person an Owner.
import crypto from "node:crypto";

const VALID_MS = 24 * 60 * 60 * 1000;
// No 0/O, 1/I/L: the code is read off a log and typed by hand.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const MAX_FAILURES_PER_MINUTE = 10;

function hash(code) {
  return crypto.createHash("sha256").update(normalize(code)).digest("hex");
}

function normalize(code) {
  return String(code || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
}

export class ClaimCodes {
  /**
   * @param {import("better-sqlite3").Database} db
   * @param {import("./directory.js").Directory} directory
   * @param {{ now?: () => number }} [opts]
   */
  constructor(db, directory, opts = {}) {
    this.db = db;
    this.directory = directory;
    this.now = opts.now || Date.now;
    this.failures = [];
  }

  /** A new code, returned once. Only its hash is stored. */
  create(actorLabel) {
    let code = "";
    for (const byte of crypto.randomBytes(12)) code += ALPHABET[byte % ALPHABET.length];
    code = code.match(/.{4}/g).join("-");
    const now = this.now();
    this.db.prepare("INSERT INTO claim_codes (hash, created_at, expires_at) VALUES (?, ?, ?)").run(hash(code), now, now + VALID_MS);
    this.directory.audit(actorLabel, "claim_code.created", null, null, `${actorLabel} created an Owner claim code (valid 24 hours, single use)`);
    return { code, expiresAt: now + VALID_MS };
  }

  /** Print a code at startup when no one owns this install yet (remote-first installs). */
  createIfUnowned(log = console.log) {
    if (this.directory.hasOwner()) return null;
    const pending = this.db.prepare("SELECT 1 FROM claim_codes WHERE used_at IS NULL AND expires_at > ?").get(this.now());
    if (pending) return null;
    const { code, expiresAt } = this.create("sparkDash");
    log(
      `[access] No Owner yet. Open sparkDash through Tailscale Serve and enter this claim code to become Owner: ${code}` +
        ` (single use, expires ${new Date(expiresAt).toISOString()}). The local console already has Owner rights.`
    );
    return code;
  }

  /**
   * Redeem a code for a person Tailscale has named. Returns the updated person.
   * @param {string} code
   * @param {{ login: string, name?: string | null, device?: string | null }} identity
   */
  redeem(code, identity) {
    const now = this.now();
    this.failures = this.failures.filter((t) => now - t < 60_000);
    if (this.failures.length >= MAX_FAILURES_PER_MINUTE) {
      return { ok: false, status: 429, error: "Too many wrong claim codes. Wait a minute and try again." };
    }
    const row = this.db.prepare("SELECT * FROM claim_codes WHERE hash = ?").get(hash(code));
    const fail = (error) => {
      this.failures.push(now);
      return { ok: false, status: 400, error };
    };
    if (!row) return fail("That claim code isn't right. Check it against the server log and try again.");
    if (row.used_at) return fail("That claim code has already been used. Ask an Owner for a new one.");
    if (row.expires_at <= now) return fail("That claim code has expired. Restart sparkDash to print a new one, or create one from Settings on the local console.");
    const used = this.db.prepare("UPDATE claim_codes SET used_at = ?, used_by = ? WHERE hash = ? AND used_at IS NULL").run(now, identity.login, row.hash);
    if (!used.changes) return fail("That claim code has already been used.");
    return { ok: true, person: this.directory.grant(identity.login, identity, "owner") };
  }
}
