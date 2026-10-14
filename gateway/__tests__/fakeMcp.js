// A fake remote MCP server (Streamable HTTP) for Gateway tests.
import http from "node:http";
import crypto from "node:crypto";
import { once } from "node:events";

/**
 * @param {{ sse?: boolean, auth?: string, tools?: string[] }} opts
 *        sse: answer as an event stream; auth: required Authorization value; tools: tool names
 */
export async function startFakeMcp({ sse = false, auth = null, tools = ["echo", "add", "fail"] } = {}) {
  const sessions = new Set();
  const seen = [];
  const stats = { initializes: 0 };
  const defs = tools.map((name) => ({ name, description: `The ${name} tool`, inputSchema: { type: "object", properties: { text: { type: "string" } } } }));

  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const msg = raw ? JSON.parse(raw) : null;
    seen.push({ method: req.method, headers: { ...req.headers }, msg });
    if (req.method !== "POST") return res.writeHead(405).end();
    if (auth && req.headers.authorization !== auth) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "unauthorized" }));
    }
    const reply = (obj, headers = {}) => {
      if (sse) {
        res.writeHead(200, { "content-type": "text/event-stream", ...headers });
        // A server notification first, which the client must skip.
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "working" } })}\n\n`);
        res.end(`event: message\ndata: ${JSON.stringify(obj)}\n\n`);
      } else {
        res.writeHead(200, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(obj));
      }
    };
    if (msg.method === "initialize") {
      stats.initializes++;
      const id = crypto.randomUUID();
      sessions.add(id);
      return reply({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } }, { "mcp-session-id": id });
    }
    const sid = req.headers["mcp-session-id"];
    if (!sid || !sessions.has(sid)) return res.writeHead(404).end();
    if (msg.id === undefined) return res.writeHead(202).end();
    if (msg.method === "tools/list") {
      // Two pages, to exercise the cursor.
      const page = msg.params?.cursor === "p2" ? defs.slice(1) : defs.slice(0, 1);
      return reply({ jsonrpc: "2.0", id: msg.id, result: { tools: page, ...(msg.params?.cursor ? {} : { nextCursor: "p2" }) } });
    }
    if (msg.method === "tools/call") {
      const { name, arguments: args } = msg.params;
      if (name === "fail") return reply({ jsonrpc: "2.0", id: msg.id, error: { code: -32010, message: "the fail tool always fails" } });
      if (name === "add") return reply({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: String((args?.a ?? 0) + (args?.b ?? 0)) }] } });
      return reply({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `echo: ${args?.text ?? ""}` }] } });
    }
    return reply({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no such method" } });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    seen,
    stats,
    /** Forget every session, as a restarted server would. */
    expireSessions: () => sessions.clear(),
    close: () => new Promise((r) => (server.closeAllConnections(), server.close(r))),
  };
}
