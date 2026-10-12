// Starts a Gateway (public + internal listeners) against a fake upstream, in a temp directory.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { loadConfig } from "../config.js";
import { createGateway } from "../index.js";
import { createInternalHandler } from "../internal/server.js";
import { startFakeUpstream } from "./fakeUpstream.js";

export const KEYS = {
  anthropic: "sk-ant-api03-PLANTEDanthropicKEY0000000000000000000000000000000000000000000000000000000-AA",
  openai: "sk-proj-PLANTEDopenaiKEY000000000000000000000000000000000000000000000000000000000000AA",
  gemini: "AIzaPLANTEDgeminiKEY00000000000000000AA",
};

/** Peer IPs a test can impersonate don't exist; Serve headers from loopback are what Serve sends. */
export async function startGateway(t, { whoisTable = {}, env = {} } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sd-gateway-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const upstream = await startFakeUpstream({ keys: KEYS });
  t.after(() => upstream.close());
  const logs = [];
  const config = loadConfig({ GATEWAY_DATA_DIR: path.join(tmp, "data"), GATEWAY_IPC_DIR: path.join(tmp, "ipc"), GATEWAY_STATIC_DIR: path.join(tmp, "dist"), ...env });
  const gw = createGateway(config, {
    log: (l) => logs.push(l),
    whois: async (ip) => whoisTable[ip] ?? null,
    checkUrl: async () => null,
  });
  t.after(() => gw.db.close());

  const pub = http.createServer({ noDelay: true }, gw.publicHandler);
  pub.listen(0, "127.0.0.1");
  await once(pub, "listening");
  t.after(() => new Promise((r) => (pub.closeAllConnections(), pub.close(r))));

  const secret = "a".repeat(64);
  const internal = http.createServer(createInternalHandler({ secret, state: gw.state, providers: gw.providers, grants: gw.grants, keys: gw.keys, config, version: gw.version }));
  const sock = path.join(tmp, "gw.sock");
  internal.listen(sock);
  await once(internal, "listening");
  t.after(() => new Promise((r) => internal.close(r)));

  const base = `http://127.0.0.1:${pub.address().port}`;
  const seenResponses = [];
  /** Every response body and header the test sees, for the no-secret grep. */
  const call = async (p, init = {}) => {
    const r = await fetch(`${base}${p}`, init);
    const text = await r.text();
    // Label with the path only: a test may put a key in the query string on purpose.
    seenResponses.push(`${p.split("?")[0]} ${r.status} ${JSON.stringify([...r.headers])} ${text}`);
    return { status: r.status, headers: r.headers, text, json: () => JSON.parse(text) };
  };
  const admin = (method, p, body, actor = "Test Admin") =>
    new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : "";
      const req = http.request(
        { socketPath: sock, path: `/internal/admin${p}`, method, headers: { "x-sparkdash-internal": secret, "x-sparkdash-actor": encodeURIComponent(actor), "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
        async (res) => {
          let text = "";
          for await (const c of res) text += c;
          seenResponses.push(`admin ${method} ${p} ${res.statusCode} ${text}`);
          resolve({ status: res.statusCode, json: () => JSON.parse(text), text });
        }
      );
      req.on("error", reject);
      req.end(payload);
    });
  const internalCall = (method, p, body, headerSecret = secret) =>
    new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : "";
      const req = http.request({ socketPath: sock, path: p, method, headers: { "x-sparkdash-internal": headerSecret, "content-length": Buffer.byteLength(payload) } }, async (res) => {
        let text = "";
        for await (const c of res) text += c;
        seenResponses.push(`internal ${method} ${p} ${res.statusCode} ${text}`);
        resolve({ status: res.statusCode, json: () => JSON.parse(text) });
      });
      req.on("error", reject);
      req.end(payload);
    });

  /** Add the three providers against the fake upstream and turn the Gateway on. */
  async function setup() {
    for (const [type, key] of Object.entries(KEYS)) {
      const r = await admin("POST", "/providers", { type, key, baseUrl: upstream.url });
      if (!r.json().saved) throw new Error(`setup: ${type} not saved: ${r.text}`);
    }
    await admin("POST", "/enable");
  }

  return { gw, base, upstream, call, admin, internalCall, setup, logs, seenResponses, dataDir: config.dataDir };
}
