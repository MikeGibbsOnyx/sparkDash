// Onyx: the Observer's client for the Gateway's internal API (Unix socket + shared secret).
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const GATEWAY_IPC_DIR = process.env.GATEWAY_IPC_DIR || path.join(ROOT, "ipc");

export class GatewayDown extends Error {
  constructor(message) {
    super(message);
    this.status = 503;
  }
}

export function createGatewayClient({ ipcDir = GATEWAY_IPC_DIR, timeoutMs = 20_000 } = {}) {
  const socketPath = path.join(ipcDir, "gateway.sock");
  const secretPath = path.join(ipcDir, "internal.secret");
  let secret = "";

  function readSecret() {
    try {
      secret = fs.readFileSync(secretPath, "utf8").trim();
    } catch {
      secret = "";
    }
    return secret;
  }

  function once(method, p, body, actor) {
    return new Promise((resolve, reject) => {
      if (!fs.existsSync(socketPath)) return reject(new GatewayDown("No ipc/gateway.sock: the Gateway container isn't running, or the Observer doesn't share its ipc volume."));
      const payload = body === undefined ? "" : JSON.stringify(body);
      const req = http.request(
        {
          socketPath,
          path: p,
          method,
          timeout: timeoutMs,
          headers: {
            "x-sparkdash-internal": secret || readSecret(),
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payload),
            ...(actor ? { "x-sparkdash-actor": encodeURIComponent(actor) } : {}),
          },
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (d) => (text += d));
          res.on("end", () => {
            let json = {};
            try {
              json = text ? JSON.parse(text) : {};
            } catch {
              json = { error: "The Gateway sent an unreadable answer." };
            }
            resolve({ status: res.statusCode, body: json });
          });
        }
      );
      req.on("timeout", () => req.destroy(new GatewayDown("The Gateway didn't answer in time.")));
      req.on("error", (err) => reject(err instanceof GatewayDown ? err : new GatewayDown(`The Gateway isn't answering (${err.code || err.message}). Check: docker compose ps gateway`)));
      req.end(payload);
    });
  }

  /** One retry with a fresh secret, in case the Gateway made a new one since we read it. */
  async function call(method, p, body, actor) {
    let r = await once(method, p, body, actor);
    if (r.status === 401) {
      readSecret();
      r = await once(method, p, body, actor);
    }
    return r;
  }

  return { call };
}
