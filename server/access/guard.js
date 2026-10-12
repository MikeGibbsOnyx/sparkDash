// Onyx: identity + role check for every dashboard request and the WebSocket upgrade.
import { resolveIdentity } from "../../shared/identity/index.js";
import { ROLE_LABELS, atLeast } from "./roles.js";
import { minRoleFor } from "./routeRoles.js";

/**
 * @param {object} deps
 * @param {import("./directory.js").Directory} deps.directory
 * @param {(ip: string, port?: number) => Promise<object | null>} deps.whois
 * @param {() => boolean} deps.listenerLoopback
 * @param {() => boolean} deps.localConsole
 * @param {(req: any) => boolean} deps.tokenOk  The request carries the configured SPARKDASH_TOKEN.
 * @param {() => boolean} deps.tokenConfigured
 */
export function createAccessGuard(deps) {
  const { directory, whois, listenerLoopback, localConsole, tokenOk, tokenConfigured } = deps;

  /**
   * Who is calling and what role they hold.
   * @returns {Promise<{ ok: true, via: string, role: string | null, label: string, login: string | null, name: string | null, device: string | null, tagged?: boolean, tags?: string[] } | { ok: false, status: number, error: string, fix: string }>}
   */
  async function identify(req) {
    const token = tokenOk(req);
    const id = await resolveIdentity(req, { listenerLoopback: listenerLoopback(), whois, localConsole: localConsole() });
    if (!id.ok) {
      // SPARKDASH_TOKEN (scripts, Prometheus, reverse-proxy installs) acts as Admin.
      if (token) return { ok: true, via: "token", role: "admin", label: "SPARKDASH_TOKEN", login: null, name: null, device: null };
      return id;
    }
    if (id.via === "local") {
      // Matches today's local trust: with a token configured, the console reads freely and needs the token to change things.
      const role = !tokenConfigured() || token ? "owner" : "auditor";
      return { ok: true, via: "local", role, label: "local console", login: null, name: null, device: null };
    }
    if (id.tagged) {
      return { ok: true, via: id.via, role: token ? "admin" : null, label: token ? "SPARKDASH_TOKEN" : id.device, login: null, name: null, device: id.device, tagged: true, tags: id.tags };
    }
    const person = directory.seen(id);
    // A person who also sends the token gets at least Admin, never less than their own role.
    const role = token && !atLeast(person.role, "admin") ? "admin" : person.role;
    return { ok: true, via: id.via, role, label: person.display_name || person.login, login: person.login, name: person.display_name, device: id.device };
  }

  function denial(access, min) {
    if (!access.ok) return { status: access.status, body: { error: access.error, fix: access.fix } };
    if (access.tagged && !access.role) {
      return { status: 403, body: { error: `${access.device || "This device"} is a tagged device; tagged devices can't use the dashboard.`, fix: "Open sparkDash from a person's device, or send SPARKDASH_TOKEN." } };
    }
    if (!atLeast(access.role, min)) {
      return {
        status: 403,
        body: {
          error: `This needs the ${ROLE_LABELS[min]} role. You're ${access.role === "admin" || access.role === "auditor" || access.role === "owner" ? "an" : "a"} ${ROLE_LABELS[access.role]}.`,
          fix: "Ask an Owner or Admin to change your role on the People page.",
          role: access.role,
          required: min,
        },
      };
    }
    return null;
  }

  async function middleware(req, res, next) {
    let access;
    try {
      access = await identify(req);
    } catch (err) {
      console.error("[access] identity check failed:", err?.message);
      return res.status(500).json({ error: "sparkDash couldn't check who you are.", fix: "Try again; if it repeats, check the server log." });
    }
    req.access = access;
    const min = minRoleFor(req.method, req.path);
    if (min === null) return next();
    const deny = denial(access, min);
    if (!deny) return next();
    if (req.method === "GET" && /text\/html/.test(req.headers?.accept || "")) {
      const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
      return res.status(deny.status).type("html").send(`<!doctype html><title>sparkDash: access</title><p>${esc(deny.body.error)}</p><p>${esc(deny.body.fix)}</p>`);
    }
    return res.status(deny.status).json(deny.body);
  }

  /** WebSocket upgrade: the live fleet snapshot needs Auditor. */
  async function authorizeUpgrade(req) {
    try {
      const access = await identify(req);
      return !denial(access, "auditor");
    } catch {
      return false;
    }
  }

  return { identify, middleware, authorizeUpgrade };
}
