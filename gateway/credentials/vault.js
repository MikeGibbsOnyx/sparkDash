// Onyx Gateway: the AES-256-GCM key for provider keys and other stored secrets.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { KEY_LEN, decrypt, encrypt, keyFromString } from "../../shared/crypto.js";

/**
 * GATEWAY_SECRETS_KEY wins; otherwise gateway-data/secrets.key, created 0600 on first use.
 * Never overwrites an existing key file: that would orphan every saved provider key.
 */
export function loadVaultKey({ secretsKey, secretsKeyPath }) {
  if (secretsKey) return keyFromString(secretsKey);
  if (fs.existsSync(secretsKeyPath)) {
    const raw = fs.readFileSync(secretsKeyPath, "utf8").trim();
    if (!raw) throw new Error(`${secretsKeyPath} is empty. Restore it from a backup, or remove it and re-enter your provider keys.`);
    return keyFromString(raw);
  }
  fs.mkdirSync(path.dirname(secretsKeyPath), { recursive: true });
  const key = crypto.randomBytes(KEY_LEN);
  fs.writeFileSync(secretsKeyPath, key.toString("hex") + "\n", { mode: 0o600, flag: "wx" });
  return key;
}

export function createVault(key) {
  return {
    seal: (plaintext) => encrypt(plaintext, key),
    open: (ciphertext) => decrypt(ciphertext, key),
  };
}
