// Onyx Gateway: added time to first byte, measured against a local fake upstream so network
// noise doesn't hide a few milliseconds. Phase 2 target: under 5 ms at p50.
// Usage: node gateway/bench/overhead.mjs [requests=200]
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { loadConfig } from "../config.js";
import { createGateway } from "../index.js";

const N = Number(process.argv[2] || 200);
const KEY = "sk-ant-api03-benchBENCHbenchBENCHbenchBENCHbench";

const upstream = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data: [{ id: "claude-bench" }] }));
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
    setTimeout(() => res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n'), 5);
  });
});
upstream.listen(0, "127.0.0.1");
await once(upstream, "listening");
const upUrl = `http://127.0.0.1:${upstream.address().port}`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sd-bench-"));
const gw = createGateway(loadConfig({ GATEWAY_DATA_DIR: tmp, GATEWAY_IPC_DIR: tmp }), { checkUrl: async () => null, whois: async () => null, log: () => {} });
await gw.providers.add({ type: "anthropic", key: KEY, baseUrl: upUrl, actor: "bench" });
gw.state.set("enabled", true);
gw.grants.ensureDefault("bench");
const pub = http.createServer({ noDelay: true }, gw.publicHandler);
pub.listen(0, "127.0.0.1");
await once(pub, "listening");
const gwUrl = `http://127.0.0.1:${pub.address().port}`;

const body = JSON.stringify({ model: "claude-bench", max_tokens: 5, stream: true, messages: [{ role: "user", content: "hi" }] });
async function ttfb(url, headers) {
  const t0 = performance.now();
  const r = await fetch(`${url}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  const reader = r.body.getReader();
  await reader.read();
  const ms = performance.now() - t0;
  while (!(await reader.read()).done);
  return ms;
}
for (let i = 0; i < 20; i++) {
  await ttfb(upUrl, { "x-api-key": KEY });
  await ttfb(gwUrl, { authorization: "Bearer sparkdash" });
}
const d = [];
const g = [];
for (let i = 0; i < N; i++) {
  d.push(await ttfb(upUrl, { "x-api-key": KEY }));
  g.push(await ttfb(gwUrl, { authorization: "Bearer sparkdash" }));
}
const q = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
console.log(
  JSON.stringify({
    requests: N,
    directP50: q(d, 0.5).toFixed(2),
    gatewayP50: q(g, 0.5).toFixed(2),
    addedP50: (q(g, 0.5) - q(d, 0.5)).toFixed(2),
    addedP90: (q(g, 0.9) - q(d, 0.9)).toFixed(2),
  })
);
pub.closeAllConnections();
pub.close();
upstream.closeAllConnections();
upstream.close();
gw.db.close();
fs.rmSync(tmp, { recursive: true, force: true });
