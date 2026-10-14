// Onyx Gateway: the MCP proxy at /mcp. One endpoint combines the tools of every remote MCP server
// an Admin added, named <server>__<tool>; each caller sees only the tools their grants allow.
// Streamable HTTP, stateless on this side: initialize, ping, tools/list and tools/call are
// answered as JSON; notifications get 202; GET /mcp is 405 (no server-initiated messages).
import { redact } from "../../shared/redact.js";
import { PROTOCOL_VERSION } from "./client.js";
import { storedHeaders } from "../logging/capture.js";

const SUPPORTED = [PROTOCOL_VERSION, "2025-03-26", "2024-11-05"];
const SEP = "__";

const rpcError = (id, code, message, data) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } });
const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });

/** "github__create_issue" -> { server: "github", tool: "create_issue" } */
export function splitToolName(name) {
  const s = String(name || "");
  const i = s.indexOf(SEP);
  return i > 0 ? { server: s.slice(0, i), tool: s.slice(i + SEP.length) } : null;
}

/**
 * @param {object} deps
 * @param {import("./servers.js").McpServers} deps.servers
 * @param {import("../policy/grants.js").Grants} deps.grants
 * @param {import("../usage/ledger.js").Usage} deps.usage
 * @param {import("../logging/capture.js").CaptureStore} deps.capture
 * @param {import("../store/state.js").State} deps.state
 * @param {string} deps.version
 * @param {(line: string) => void} deps.log
 */
export function createMcpEndpoint({ servers, grants, usage, capture, state, version, log }) {
  async function visibleTools(who) {
    return (await servers.allTools())
      .map(({ server, tool }) => ({ ...tool, name: `${server}${SEP}${tool.name}` }))
      .filter((t) => grants.allowsTool(who, t.name));
  }

  async function callTool(id, params, who, req, client) {
    const name = String(params?.name || "");
    const parts = splitToolName(name);
    const row = parts ? servers.byName(parts.server) : null;
    const record = (status, error, ms, result) => {
      const rowId = usage.record({
        ts,
        endTs: ts + Math.round(ms),
        identity: who.label,
        via: who.via,
        kind: who.kind,
        keyName: who.keyName ?? null,
        groups: who.groups,
        device: who.device,
        client,
        providerId: row ? `mcp-${row.id}` : null,
        model: name || null,
        format: "mcp",
        stream: false,
        status,
        latencyMs: ms,
        costBasis: null,
        usageState: "unmetered",
        error,
        headers: storedHeaders(req.headers),
      });
      if (capture.mode === "full" && result !== undefined) {
        try {
          capture.write(rowId, { request: JSON.stringify({ name, arguments: params?.arguments ?? {} }), response: JSON.stringify(result) });
        } catch (err) {
          log(`[gateway] couldn't store MCP content for request ${rowId}: ${err.code || err.message}`);
        }
      }
    };
    const ts = Date.now();
    const granted = Boolean(row) && grants.allowsTool(who, name);
    const known = granted ? await servers.hasTool(row, parts.tool) : Boolean(row) && JSON.parse(row.tools || "[]").some((t) => t.name === parts.tool);
    if (!granted || !known) {
      const message = row && known && !granted
        ? `You don't have access to ${name}. Ask an Admin to add it (or ${parts.server}${SEP}*) to the MCP tools of one of your grants on the AI Gateway page's Access tab.`
        : `There's no tool ${name || "(unnamed)"} on this gateway.`;
      record(403, message, 0);
      return rpcError(id, -32602, message);
    }
    const t0 = performance.now();
    try {
      const result = await servers.client(row).callTool(parts.tool, params?.arguments);
      record(200, result?.isError ? "the tool reported an error" : null, performance.now() - t0, result);
      return rpcResult(id, result);
    } catch (err) {
      const msg = redact(String(err.message || err), [servers.secretOf(row)]);
      record(err.rpc ? 200 : 502, msg, performance.now() - t0, err.rpc ? { error: err.rpc } : undefined);
      if (err.rpc) return rpcError(id, err.rpc.code ?? -32603, redact(String(err.rpc.message || "Tool error"), [servers.secretOf(row)]), err.rpc.data);
      return rpcError(id, -32603, `${msg} (MCP server: ${row.name})`);
    }
  }

  async function one(msg, who, req, client) {
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") return rpcError(msg?.id, -32600, "Invalid request: expected a JSON-RPC 2.0 message.");
    const isNotification = msg.id === undefined || msg.id === null;
    if (isNotification) return null;
    if (typeof msg.method !== "string") return null; // a response to a request we never send
    const { id, method, params } = msg;
    if (method === "initialize") {
      const asked = params?.protocolVersion;
      return rpcResult(id, {
        protocolVersion: SUPPORTED.includes(asked) ? asked : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "sparkDash", version },
        instructions: "Tools from the MCP servers your sparkDash Admin has added, named <server>__<tool>. You see the ones your access allows.",
      });
    }
    if (method === "ping") return rpcResult(id, {});
    if (!state.enabled) return rpcError(id, -32000, "The AI gateway is turned off. An Admin can turn it on from the AI Gateway page in sparkDash.");
    if (method === "tools/list") return rpcResult(id, { tools: await visibleTools(who) });
    if (method === "tools/call") return callTool(id, params, who, req, client);
    return rpcError(id, -32601, `The gateway doesn't serve ${method}; it offers tools only.`);
  }

  /**
   * @param {import("node:http").IncomingMessage} req
   * @param {import("node:http").ServerResponse} res
   * @param {object} who
   * @param {Buffer} body
   * @param {string} client
   */
  return async function handle(req, res, who, body, client) {
    const send = (status, obj) => {
      res.writeHead(status, obj === undefined ? {} : { "content-type": "application/json" });
      res.end(obj === undefined ? undefined : JSON.stringify(obj));
    };
    let msg;
    try {
      msg = JSON.parse(body.toString("utf8"));
    } catch {
      return send(400, rpcError(null, -32700, "Parse error: the body isn't JSON."));
    }
    if (Array.isArray(msg)) {
      if (!msg.length) return send(400, rpcError(null, -32600, "Invalid request: an empty batch."));
      const out = (await Promise.all(msg.map((m) => one(m, who, req, client)))).filter(Boolean);
      return out.length ? send(200, out) : send(202);
    }
    const out = await one(msg, who, req, client);
    return out ? send(200, out) : send(202);
  };
}
