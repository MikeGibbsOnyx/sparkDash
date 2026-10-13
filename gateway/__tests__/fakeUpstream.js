// A fake provider for Gateway tests: Anthropic, OpenAI and Gemini shapes on one port.
import http from "node:http";
import { once } from "node:events";

export const ANTHROPIC_SSE = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-test","usage":{"input_tokens":12,"output_tokens":1}}}\n\n',
  'event: ping\ndata: {"type": "ping"}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"EqQBCkYIBxgCKkB=="}}\n\n',
  'event: ping\ndata: {"type": "ping"}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

/**
 * @param {{ keys: Record<string, string> }} opts  expected key per provider family
 */
export async function startFakeUpstream({ keys }) {
  const seen = [];
  /** A test sets this to pace a stream: called before each chunk after the first. */
  const control = { gate: null };

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      /* not JSON */
    }
    const url = new URL(req.url, "http://fake");
    seen.push({ method: req.method, path: url.pathname, search: url.search, headers: { ...req.headers }, body });

    const json = (status, obj, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(obj));
    };
    const authOk =
      req.headers["x-api-key"] === keys.anthropic ||
      req.headers.authorization === `Bearer ${keys.openai}` ||
      req.headers["x-goog-api-key"] === keys.gemini ||
      /^Bearer sk-ant-oat/.test(req.headers.authorization || "") ||
      req.headers.authorization === "Bearer local-key";

    if (req.method === "GET" && url.pathname === "/v1/models") {
      if (req.headers["x-api-key"] === keys.anthropic) return json(200, { data: [{ id: "claude-test" }, { id: "claude-other" }] });
      if (req.headers.authorization === `Bearer ${keys.openai}`) return json(200, { data: [{ id: "gpt-test" }, { id: "text-embedding-test" }] });
      if (req.headers.authorization === "Bearer local-key" || (!req.headers.authorization && !req.headers["x-api-key"])) return json(200, { data: [{ id: "qwen3-coder" }] });
      return json(401, { error: { message: "invalid x-api-key" } });
    }
    if (req.method === "GET" && url.pathname === "/v1beta/models") {
      if (req.headers["x-goog-api-key"] === keys.gemini) return json(200, { models: [{ name: "models/gemini-test" }] });
      return json(400, { error: { message: "API key not valid" } });
    }
    if (!authOk) return json(401, { error: { message: "no auth" } });

    const model = body.model || url.pathname;
    if (/rate-limited/.test(model)) {
      return json(429, { type: "error", error: { type: "rate_limit_error", message: "slow down" } }, {
        "retry-after": "17",
        "x-should-retry": "true",
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-reset": "1791800000",
      });
    }
    if (url.pathname === "/v1/messages" && body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "request-id": "req_fake_1" });
      const events = /drop/.test(model) ? ANTHROPIC_SSE.slice(0, 3) : ANTHROPIC_SSE;
      for (let i = 0; i < events.length; i++) {
        if (i > 0 && control.gate) await control.gate(i);
        res.write(events[i]);
      }
      if (/drop/.test(model)) {
        // Let the events reach the Gateway first, as a real mid-stream failure would.
        await new Promise((r) => setTimeout(r, 100));
        return res.socket.destroy();
      }
      return res.end();
    }
    if (url.pathname.startsWith("/v1beta/models/")) {
      if (url.pathname.endsWith(":streamGenerateContent")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"candidates":[{"content":{"parts":[{"text":"Hi"}]}}]}\r\n\r\n');
        res.end('data: {"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":1}}\r\n\r\n');
        return;
      }
      return json(200, { candidates: [{ content: { parts: [{ text: "Hi" }] } }] });
    }
    return json(200, { ok: true, path: url.pathname, model });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, port, seen, control, close: () => new Promise((r) => (server.closeAllConnections(), server.close(r))) };
}
