// Onyx: "Publish on your tailnet": tailscale serve on :8443 -> the Gateway, through the host
// namespace like TailscaleProbe. If that isn't possible, the UI shows the command to copy.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { HOST_PATHS } from "../config.js";

export const PUBLISH_PORT = 8443;

export function publishCommand(gatewayPort) {
  return `sudo tailscale serve --bg --https=${PUBLISH_PORT} http://127.0.0.1:${gatewayPort}`;
}

function run(args, timeoutMs = 15_000) {
  const mntNs = path.join(HOST_PATHS.PROC, "1", "ns", "mnt");
  const inHost = fs.existsSync(mntNs);
  const file = inHost ? "nsenter" : "tailscale";
  const argv = inHost ? [`--mount=${mntNs}`, "--", "tailscale", ...args] : args;
  return new Promise((resolve, reject) => {
    execFile(file, argv, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message).trim().split("\n")[0]));
      resolve(String(stdout));
    });
  });
}

/** Parse `tailscale serve status --json` for the Gateway's entry. */
export function parseServeStatus(json, gatewayPort) {
  const web = json?.Web || {};
  for (const [hostPort, cfg] of Object.entries(web)) {
    if (!hostPort.endsWith(`:${PUBLISH_PORT}`)) continue;
    const proxies = Object.values(cfg?.Handlers || {}).map((h) => String(h?.Proxy || ""));
    if (proxies.some((p) => p.endsWith(`:${gatewayPort}`) || p.endsWith(`:${gatewayPort}/`))) {
      return { published: true, url: `https://${hostPort.replace(`:${PUBLISH_PORT}`, "")}:${PUBLISH_PORT}`, funnel: Boolean(json?.AllowFunnel?.[hostPort]) };
    }
    return { published: false, conflict: `Port ${PUBLISH_PORT} is already published for something else (${proxies.join(", ") || "unknown"}).`, funnel: false };
  }
  return { published: false, funnel: false };
}

export async function publishStatus(gatewayPort) {
  try {
    return { ...parseServeStatus(JSON.parse(await run(["serve", "status", "--json"])), gatewayPort), command: publishCommand(gatewayPort) };
  } catch (err) {
    return { published: false, funnel: false, unknown: true, error: err.message, command: publishCommand(gatewayPort) };
  }
}

export async function publish(gatewayPort) {
  try {
    await run(["serve", "--bg", `--https=${PUBLISH_PORT}`, `http://127.0.0.1:${gatewayPort}`], 30_000);
  } catch (err) {
    return { ok: false, error: `sparkDash couldn't run tailscale serve (${err.message}). Run this on the machine instead:`, command: publishCommand(gatewayPort) };
  }
  const status = await publishStatus(gatewayPort);
  return { ok: status.published, ...status };
}
