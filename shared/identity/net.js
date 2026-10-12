// Onyx: address classification for identity resolution.
import { isIP } from "node:net";

/** Strip an IPv4-mapped IPv6 prefix and brackets: "::ffff:127.0.0.1" -> "127.0.0.1". */
export function normalizeIp(addr) {
  let a = String(addr || "").trim().replace(/^\[(.*)\]$/, "$1");
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(a)) a = a.slice(7);
  return a;
}

export function isLoopbackIp(addr) {
  const a = normalizeIp(addr);
  return a === "::1" || (isIP(a) === 4 && a.startsWith("127."));
}

/** Tailscale's CGNAT range 100.64.0.0/10 and its IPv6 ULA prefix fd7a:115c:a1e0::/48. */
export function isTailnetIp(addr) {
  const a = normalizeIp(addr);
  if (isIP(a) === 4) {
    const [o1, o2] = a.split(".").map(Number);
    return o1 === 100 && o2 >= 64 && o2 <= 127;
  }
  if (isIP(a) === 6) return /^fd7a:115c:a1e0:/i.test(expandV6Prefix(a));
  return false;
}

function expandV6Prefix(a) {
  // Enough to compare the first three hextets: pad each to 4 digits.
  const head = a.split("::")[0].split(":");
  return head.map((h) => h.padStart(4, "0")).join(":") + ":";
}

/**
 * The address that the nearest proxy saw, from X-Forwarded-For: the right-most entry.
 * A client can put anything on the left; Serve appends the real caller.
 */
export function forwardedFor(header) {
  if (!header) return "";
  const raw = Array.isArray(header) ? header.join(",") : String(header);
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length ? normalizeIp(parts[parts.length - 1]) : "";
}
