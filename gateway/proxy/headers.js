// Onyx Gateway: the forwarding rules for headers (from Anthropic's gateway compatibility guide,
// applied to every format). Everything not listed here passes through unchanged, including
// every anthropic-* header; beta values are never allowlisted.

const HOP_BY_HOP = ["connection", "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization", "te", "trailer", "trailers", "transfer-encoding", "upgrade"];
const DROP_REQUEST = new Set([
  ...HOP_BY_HOP,
  "host",
  "cookie",
  "content-length", // set from the body actually sent
  "expect",
  "forwarded",
  "x-real-ip",
  // Read for usage, never forwarded.
  "x-claude-code-session-id",
  "x-claude-code-agent-id",
]);
const DROP_REQUEST_PREFIXES = ["tailscale-", "x-forwarded-", "x-sparkdash-"];
export const CLIENT_AUTH_HEADERS = ["authorization", "x-api-key", "x-goog-api-key"];

/**
 * @param {import("node:http").IncomingHttpHeaders} incoming
 * @param {{ providerAuth: Record<string, string>, ownLogin: boolean, bodyLength: number }} opts
 */
export function outboundHeaders(incoming, { providerAuth, ownLogin, bodyLength }) {
  const out = {};
  for (const [name, value] of Object.entries(incoming)) {
    const n = name.toLowerCase();
    if (DROP_REQUEST.has(n) || DROP_REQUEST_PREFIXES.some((p) => n.startsWith(p))) continue;
    if (CLIENT_AUTH_HEADERS.includes(n) && !ownLogin) continue;
    out[n] = value;
  }
  if (!ownLogin) Object.assign(out, providerAuth);
  out["content-length"] = String(bodyLength);
  return out;
}

/** Response headers pass through unmodified (retry-after, x-should-retry, rate-limit headers…), minus hop-by-hop. */
export function inboundHeaders(upstream) {
  const out = {};
  for (const [name, value] of Object.entries(upstream)) {
    if (HOP_BY_HOP.includes(name.toLowerCase())) continue;
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/**
 * The credential a client presented, if any: its header and value. The placeholder
 * `sparkdash` means "no credential, use my Tailscale identity".
 */
export function presentedCredential(headers, searchParams) {
  const bearer = /^Bearer\s+(.+)$/i.exec(String(headers.authorization || ""))?.[1]?.trim();
  const candidates = [
    ["authorization", bearer],
    ["x-api-key", headers["x-api-key"]],
    ["x-sparkdash-key", headers["x-sparkdash-key"]],
    ["x-goog-api-key", headers["x-goog-api-key"]],
    ["query:key", searchParams?.get("key") || undefined],
  ];
  return candidates
    .filter(([, v]) => typeof v === "string" && v.trim() && v.trim() !== "sparkdash")
    .map(([where, v]) => ({ where, value: v.trim() }));
}
