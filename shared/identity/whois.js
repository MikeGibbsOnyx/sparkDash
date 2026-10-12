// Onyx: Tailscale whois through tailscaled's LocalAPI socket, with a CLI fallback.
import http from "node:http";
import { execFile } from "node:child_process";
import { normalizeIp } from "./net.js";

export const DEFAULT_SOCKET = "/var/run/tailscale/tailscaled.sock";
const TTL_MS = 60_000;
const TIMEOUT_MS = 2_000;

/**
 * The fields sparkDash uses from a whois answer, or null when Tailscale doesn't know the address.
 * @returns {{ login: string | null, name: string | null, device: string, tags: string[], tagged: boolean } | null}
 */
export function parseWhois(json) {
  if (!json || typeof json !== "object" || !json.Node) return null;
  const tags = Array.isArray(json.Node.Tags) ? json.Node.Tags : [];
  const device = String(json.Node.ComputedName || json.Node.Name || "").replace(/\.$/, "").split(".")[0];
  const tagged = tags.length > 0;
  return {
    // A tagged device's "user" is the placeholder tagged-devices profile, not a person.
    login: tagged ? null : json.UserProfile?.LoginName || null,
    name: tagged ? null : json.UserProfile?.DisplayName || null,
    device,
    tags,
    tagged,
  };
}

function localApiWhois(socketPath, addr) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { socketPath, host: "local-tailscaled.sock", path: `/localapi/v0/whois?addr=${encodeURIComponent(addr)}`, timeout: TIMEOUT_MS },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          if (res.statusCode === 404) return resolve(null);
          if (res.statusCode !== 200) return reject(new Error(`LocalAPI whois answered ${res.statusCode}`));
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error("LocalAPI whois returned unparseable JSON"));
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("LocalAPI whois timed out")));
    req.on("error", reject);
  });
}

function cliWhois(command, addr) {
  const [file, ...prefix] = command;
  return new Promise((resolve, reject) => {
    execFile(file, [...prefix, "whois", "--json", addr], { timeout: TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) {
        // "no match for IP" is an answer, not a failure.
        if (/no match|not found/i.test(String(stderr))) return resolve(null);
        return reject(new Error(String(stderr || err.message).trim()));
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error("tailscale whois returned unparseable JSON"));
      }
    });
  });
}

/**
 * Create a cached whois lookup.
 *
 * @param {object} [opts]
 * @param {string} [opts.socketPath] tailscaled LocalAPI socket.
 * @param {string[] | null} [opts.cli] Fallback command, e.g. ["tailscale"] or ["nsenter", "--mount=…", "--", "tailscale"]; null for none.
 * @param {(addr: string) => Promise<object | null>} [opts.query] Replaces both transports (tests).
 * @param {() => number} [opts.now]
 * @param {number} [opts.ttlMs]
 * @returns {(ip: string, port?: number) => Promise<ReturnType<typeof parseWhois>>} Rejects only when Tailscale can't be asked at all.
 */
export function createWhois(opts = {}) {
  const socketPath = opts.socketPath || DEFAULT_SOCKET;
  const cli = opts.cli === undefined ? ["tailscale"] : opts.cli;
  const now = opts.now || Date.now;
  const ttl = opts.ttlMs ?? TTL_MS;
  const cache = new Map();

  const query =
    opts.query ||
    (async (addr) => {
      try {
        return await localApiWhois(socketPath, addr);
      } catch (err) {
        if (!cli) throw err;
        return cliWhois(cli, addr);
      }
    });

  return async function whois(ip, port) {
    const addr = port ? `${normalizeIp(ip).includes(":") ? `[${normalizeIp(ip)}]` : normalizeIp(ip)}:${port}` : normalizeIp(ip);
    const hit = cache.get(addr);
    if (hit && now() - hit.at < ttl) return hit.value;
    const value = parseWhois(await query(addr));
    if (cache.size > 1000) cache.clear();
    cache.set(addr, { at: now(), value });
    return value;
  };
}
