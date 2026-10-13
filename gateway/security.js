// Onyx Gateway: request-level protections from the plan's security requirements.
import { isIP } from "node:net";
import dns from "node:dns/promises";

/**
 * Admin-set URLs (provider base URLs, later MCP servers and hooks): http/https only;
 * link-local and cloud metadata addresses refused. Loopback, LAN and tailnet are allowed:
 * that's where local model servers live.
 * @returns {Promise<string | null>} an error message, or null when the URL is acceptable.
 */
export async function checkOutboundUrl(raw, { resolve = dns.lookup } = {}) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return "That isn't a valid URL.";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "Only http:// and https:// URLs are allowed.";
  if (url.username || url.password) return "Put credentials in the key field, not in the URL.";
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  const addrs = isIP(host) ? [host] : await resolve(host, { all: true }).then((r) => r.map((a) => a.address), () => []);
  for (const a of addrs) {
    if (isForbidden(a)) return `${url.hostname} resolves to ${a}, a link-local or cloud metadata address, which the Gateway won't call.`;
  }
  return null;
}

function isForbidden(addr) {
  const a = addr.toLowerCase();
  if (isIP(a) === 4) {
    const [o1, o2] = a.split(".").map(Number);
    if (o1 === 169 && o2 === 254) return true; // link-local, incl. 169.254.169.254 metadata
    if (a === "100.100.100.200") return true; // Alibaba metadata
    if (o1 === 0) return true;
    return false;
  }
  if (a.startsWith("fe80:")) return true; // link-local
  if (a === "fd00:ec2::254") return true; // AWS IPv6 metadata
  if (a.startsWith("::ffff:")) return isForbidden(a.slice(7));
  return false;
}

/**
 * Model, MCP and /me endpoints refuse cross-origin browsers: a web page a person visits must
 * not spend as them. Same-origin (the Connect page) is fine; no Origin (CLIs) is fine.
 */
export function crossOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true;
  }
}

/** Fixed-window request counter per identity. */
export function createRateLimiter(perMinute, now = Date.now) {
  const windows = new Map();
  return function allow(key) {
    const t = now();
    const w = windows.get(key);
    if (!w || t - w.start >= 60_000) {
      if (windows.size > 10_000) windows.clear();
      windows.set(key, { start: t, count: 1 });
      return true;
    }
    w.count += 1;
    return w.count <= perMinute;
  };
}
