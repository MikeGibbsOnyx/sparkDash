// Onyx: AES-256-GCM helpers shared by the Observer (server/secretsStore.js) and the Gateway.
// Format: base64(iv[12] | tag[16] | ciphertext), unchanged from secretsStore so existing
// secrets keep decrypting.
import crypto from "node:crypto";

export const ALGO = "aes-256-gcm";
export const IV_LEN = 12;
export const TAG_LEN = 16;
export const KEY_LEN = 32;

/** A 32-byte key from 64 hex characters, or the SHA-256 of a passphrase. */
export function keyFromString(s) {
  const t = String(s).trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return Buffer.from(t, "hex");
  return crypto.createHash("sha256").update(t, "utf8").digest();
}

export function encrypt(plaintext, key) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decrypt(blobB64, key) {
  const buf = Buffer.from(blobB64, "base64");
  if (buf.length < IV_LEN + TAG_LEN + 1) throw new Error("ciphertext too short");
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const data = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
