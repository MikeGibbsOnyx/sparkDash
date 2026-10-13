// Onyx Gateway: configuration from the environment, with the bind rules from the plan.
import path from "node:path";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Loopback, tailnet (100.64.0.0/10, fd7a:115c:a1e0::/48) or private addresses are allowed without opt-in. */
export function bindHostClass(host) {
  const h = String(host || "").replace(/^\[(.*)\]$/, "$1");
  if (h === "localhost" || h === "::1" || /^127\./.test(h)) return "loopback";
  if (isIP(h) === 4) {
    const [a, b] = h.split(".").map(Number);
    if (a === 100 && b >= 64 && b <= 127) return "tailnet";
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "private";
    return "public";
  }
  if (isIP(h) === 6) {
    if (/^fd7a:115c:a1e0:/i.test(h)) return "tailnet";
    if (/^f[cd]/i.test(h)) return "private";
    return "public";
  }
  // 0.0.0.0, ::, hostnames: treat as public.
  return "public";
}

/**
 * @param {NodeJS.ProcessEnv} env
 */
export function loadConfig(env = process.env) {
  const bindHost = env.GATEWAY_BIND_HOST || "127.0.0.1";
  const bindClass = bindHostClass(bindHost);
  if (bindClass === "public" && env.GATEWAY_ALLOW_PUBLIC_BIND !== "1") {
    throw new Error(
      `GATEWAY_BIND_HOST=${bindHost} is not a loopback, tailnet or private address. The Gateway holds your provider keys; ` +
        `bind it to 127.0.0.1 and publish it with Tailscale Serve, or set GATEWAY_ALLOW_PUBLIC_BIND=1 if you really mean it.`
    );
  }
  const dataDir = env.GATEWAY_DATA_DIR || path.join(ROOT, "gateway-data");
  const ipcDir = env.GATEWAY_IPC_DIR || path.join(ROOT, "ipc");
  return {
    root: ROOT,
    bindHost,
    bindClass,
    port: Number(env.GATEWAY_PORT || 5556),
    dataDir,
    ipcDir,
    socketPath: path.join(ipcDir, "gateway.sock"),
    secretPath: path.join(ipcDir, "internal.secret"),
    secretsKey: env.GATEWAY_SECRETS_KEY || "",
    secretsKeyPath: path.join(dataDir, "secrets.key"),
    staticDir: env.GATEWAY_STATIC_DIR || path.join(ROOT, "dist"),
    maxBodyBytes: Math.max(1, Number(env.GATEWAY_MAX_BODY_MB || 32)) * 1024 * 1024,
    ratePerMinute: Math.max(1, Number(env.GATEWAY_RATE_PER_MINUTE || 600)),
    connectTimeoutMs: Number(env.GATEWAY_CONNECT_TIMEOUT_MS || 10_000),
    // Long non-streaming requests (extended thinking) can take minutes before the first byte.
    headersTimeoutMs: Number(env.GATEWAY_FIRST_BYTE_TIMEOUT_MS || 10 * 60_000),
    tailscaledSocket: env.TAILSCALED_SOCKET || "/var/run/tailscale/tailscaled.sock",
    envProviderKeys: {
      anthropic: env.GATEWAY_ANTHROPIC_API_KEY || "",
      openai: env.GATEWAY_OPENAI_API_KEY || "",
      gemini: env.GATEWAY_GEMINI_API_KEY || "",
    },
  };
}
