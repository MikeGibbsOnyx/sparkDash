// Onyx: Observer access control: directory, roles, route guards, claim codes.
import fs from "node:fs";
import path from "node:path";
import { createWhois, DEFAULT_SOCKET } from "../../shared/identity/index.js";
import { openAccessDb } from "./db.js";
import { Directory } from "./directory.js";
import { ClaimCodes } from "./claims.js";
import { createAccessGuard } from "./guard.js";
import { registerAccessRoutes } from "./routes.js";

export { minRoleFor } from "./routeRoles.js";
export { ROLES, atLeast } from "./roles.js";

/**
 * Where to ask tailscaled. In the Observer container the host's socket is under the
 * host root mount; the CLI fallback enters the host mount namespace like TailscaleProbe.
 */
function whoisTransport(env = process.env) {
  const hostRoot = env.HOST_ROOT_PATH || "";
  const hostProc = env.HOST_PROC_PATH || "/proc";
  const hostSocket = hostRoot ? path.join(hostRoot, DEFAULT_SOCKET) : "";
  const socketPath = env.TAILSCALED_SOCKET || (hostSocket && fs.existsSync(hostSocket) ? hostSocket : DEFAULT_SOCKET);
  const mntNs = path.join(hostProc, "1", "ns", "mnt");
  const cli = hostRoot && fs.existsSync(mntNs) ? ["nsenter", `--mount=${mntNs}`, "--", "tailscale"] : ["tailscale"];
  return { socketPath, cli };
}

/**
 * @param {object} opts
 * @param {(event: object) => void} opts.onEvent     Activity sink (recordEvent).
 * @param {() => boolean} opts.listenerLoopback
 * @param {(req: any) => boolean} opts.tokenOk
 * @param {() => boolean} opts.tokenConfigured
 * @param {string} [opts.dbPath]
 * @param {() => void} [opts.onDirectoryChange]  people or groups changed (the Gateway bridge pushes a snapshot)
 */
export function createAccess(opts) {
  const db = openAccessDb(opts.dbPath);
  const directory = new Directory(db, { onEvent: opts.onEvent, onChange: () => opts.onDirectoryChange?.() });
  const claims = new ClaimCodes(db, directory);
  const whois = createWhois(whoisTransport());
  const guard = createAccessGuard({
    directory,
    whois,
    listenerLoopback: opts.listenerLoopback,
    localConsole: () => process.env.SPARKDASH_LOCAL_CONSOLE !== "0",
    tokenOk: opts.tokenOk,
    tokenConfigured: opts.tokenConfigured,
  });
  return {
    db,
    directory,
    claims,
    guard,
    registerRoutes: (app) => registerAccessRoutes(app, { directory, claims }),
    close: () => db.close(),
  };
}
