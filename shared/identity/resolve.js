// Onyx: who is calling. Tailscale names the person; sparkDash decides what they may do.
import { forwardedFor, isLoopbackIp, isTailnetIp, normalizeIp } from "./net.js";

/**
 * Decode an RFC 2047 encoded-word, which Serve uses for non-ASCII header values
 * (e.g. "=?utf-8?q?Ren=C3=A9?=").
 */
export function decodeHeaderWord(value) {
  const s = String(value || "");
  return s.replace(/=\?utf-8\?([bq])\?([^?]*)\?=/gi, (_m, enc, text) => {
    try {
      if (enc.toLowerCase() === "b") return Buffer.from(text, "base64").toString("utf8");
      const bytes = text.replace(/_/g, " ").replace(/=([0-9a-f]{2})/gi, (_x, h) => String.fromCharCode(parseInt(h, 16)));
      return Buffer.from(bytes, "latin1").toString("utf8");
    } catch {
      return s;
    }
  });
}

const FIX_SERVE_OR_TOKEN = "Open sparkDash through Tailscale Serve, or send SPARKDASH_TOKEN.";

function refused(error, fix = FIX_SERVE_OR_TOKEN) {
  return { ok: false, status: 401, error, fix };
}

/**
 * Resolve the caller of a request. First match wins:
 *   1. gateway key (when `opts.gatewayKey` is given; Gateway only)
 *   2. Tailscale Serve headers: loopback peer on a loopback-bound listener with Tailscale-User-Login
 *   3. tailscaled whois: a tailnet peer, or a loopback peer forwarding a tailnet IP
 *   4. local console: loopback peer, no Serve headers, no forwarded IP (unless turned off)
 * Anything else is refused with a 401 that names the fix.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {object} opts
 * @param {boolean} opts.listenerLoopback The listener is bound to a loopback address (Serve headers are trusted only then).
 * @param {(ip: string, port?: number) => Promise<object | null>} [opts.whois]
 * @param {boolean} [opts.localConsole=true]
 * @param {(req: any) => Promise<object | null> | object | null} [opts.gatewayKey]
 * @returns {Promise<{ ok: true, via: string, login: string | null, name: string | null, device: string | null, tags: string[], tagged: boolean, ip: string | null } | { ok: false, status: number, error: string, fix: string }>}
 */
export async function resolveIdentity(req, opts) {
  const { listenerLoopback, whois, localConsole = true, gatewayKey } = opts;
  const headers = req.headers || {};
  const peer = normalizeIp(req.socket?.remoteAddress);
  const peerLoopback = isLoopbackIp(peer);

  if (gatewayKey) {
    const key = await gatewayKey(req);
    if (key) return key.ok === false ? key : { ok: true, via: "key", tags: [], tagged: false, ip: peer, device: null, name: null, ...key };
  }

  const xff = forwardedFor(headers["x-forwarded-for"]);
  const serveLogin = String(headers["tailscale-user-login"] || "").trim();

  // Funnel (or anything forwarding a public address) is refused even if it carries a login.
  if (peerLoopback && xff && !isTailnetIp(xff)) return refused(`sparkDash can't identify a request forwarded from ${xff}.`);

  if (peerLoopback && listenerLoopback && serveLogin) {
    let device = null;
    if (xff && isTailnetIp(xff) && whois) {
      // Device name is a nicety; a failed lookup must not refuse a person Serve already named.
      device = await whois(xff).then((w) => w?.device || null, () => null);
    }
    return {
      ok: true,
      via: "serve",
      login: decodeHeaderWord(serveLogin).toLowerCase(),
      name: decodeHeaderWord(headers["tailscale-user-name"] || "") || null,
      device,
      tags: [],
      tagged: false,
      ip: xff || null,
    };
  }

  const tailnetCaller = isTailnetIp(peer) ? { ip: peer, port: req.socket?.remotePort } : peerLoopback && xff && isTailnetIp(xff) ? { ip: xff } : null;
  if (tailnetCaller) {
    if (!whois) return refused(`sparkDash can't ask Tailscale who ${tailnetCaller.ip} is.`, "Mount tailscaled.sock, or open sparkDash through Tailscale Serve.");
    let w;
    try {
      w = await whois(tailnetCaller.ip, tailnetCaller.port);
    } catch {
      return refused(`Tailscale couldn't be asked who ${tailnetCaller.ip} is.`, "Check that tailscaled is running on this machine, then reload.");
    }
    if (!w) return refused(`Tailscale doesn't know ${tailnetCaller.ip}.`, "Connect from a device on this tailnet.");
    return { ok: true, via: "whois", ...w, ip: tailnetCaller.ip };
  }

  if (peerLoopback && !xff && !serveLogin) {
    if (!localConsole) return refused("The local console is turned off on this machine (SPARKDASH_LOCAL_CONSOLE=0).");
    return { ok: true, via: "local", login: null, name: null, device: null, tags: [], tagged: false, ip: peer };
  }

  if (peerLoopback && xff) return refused(`sparkDash can't identify a request forwarded from ${xff}.`);
  if (peerLoopback && serveLogin) return refused("Tailscale Serve headers arrived on a listener that isn't loopback-bound, so they aren't trusted.");
  return refused(`sparkDash can't identify ${peer || "this caller"}.`);
}
