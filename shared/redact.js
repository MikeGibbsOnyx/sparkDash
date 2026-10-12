// Onyx: mask anything shaped like a credential before it reaches a log, an error or a response.

const PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic API keys and OAuth tokens (sk-ant-oat…)
  /sk-or-[A-Za-z0-9_-]{8,}/g, // OpenRouter
  /sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{16,}/g, // OpenAI
  /AIza[A-Za-z0-9_-]{20,}/g, // Google
  /sdgw_[A-Za-z0-9]{8,}/g, // sparkDash gateway keys
  /gh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub
  /xox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWTs (OAuth access tokens)
  /(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi,
];

/** Keep a recognisable prefix, drop the rest: "sk-ant-api03-abc…" -> "sk-ant…[redacted]". */
export function redact(value, extraSecrets = []) {
  let s = typeof value === "string" ? value : String(value);
  for (const secret of extraSecrets) {
    if (secret && secret.length >= 6) s = s.split(secret).join("[redacted]");
  }
  for (const re of PATTERNS) {
    s = s.replace(re, (m, bearer) => (bearer ? `${bearer}[redacted]` : `${m.slice(0, 6)}…[redacted]`));
  }
  return s;
}

/** Last four characters for display: never more of a key than that. */
export function last4(key) {
  const k = String(key || "");
  return k.length >= 8 ? k.slice(-4) : "";
}
