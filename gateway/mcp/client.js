// Onyx Gateway: a client for one remote MCP server over Streamable HTTP. It speaks JSON-RPC by
// POST, reads the answer as JSON or as an SSE stream, keeps one session per server
// (Mcp-Session-Id), and re-initialises once when the server says the session has expired.
import { createSseReader } from "../usage/tap.js";

export const PROTOCOL_VERSION = "2025-06-18";
const INIT_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 120_000;

export class McpError extends Error {
  /** @param {string} message @param {{ status?: number, rpc?: { code: number, message: string, data?: unknown }, expired?: boolean }} [extra] */
  constructor(message, extra = {}) {
    super(message);
    Object.assign(this, extra);
  }
}

/**
 * @param {object} p
 * @param {string} p.url
 * @param {Record<string, string>} p.headers   the server's credential header, if any
 * @param {typeof fetch} [p.fetchImpl]
 * @param {string} [p.version]                  our version, for clientInfo
 */
export function createMcpClient({ url, headers = {}, fetchImpl = fetch, version = "0" }) {
  let session = null; // { id: string | null, protocol: string }
  let initializing = null;
  let nextId = 1;

  async function post(message, { timeoutMs, sessionHeaders = true } = {}) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const h = { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers };
    if (sessionHeaders && session) {
      if (session.id) h["mcp-session-id"] = session.id;
      h["mcp-protocol-version"] = session.protocol;
    }
    let res;
    try {
      res = await fetchImpl(url, { method: "POST", headers: h, body: JSON.stringify(message), signal: ac.signal, redirect: "error" });
    } catch (err) {
      clearTimeout(timer);
      const code = err?.name === "AbortError" ? "timed out" : err?.cause?.code || err?.code || err?.message || "failed";
      throw new McpError(`The MCP server didn't answer (${code}).`);
    }
    try {
      if (res.status === 404 && sessionHeaders && session?.id) throw new McpError("The MCP session expired.", { status: 404, expired: true });
      if (res.status === 401 || res.status === 403) throw new McpError(`The MCP server refused the Gateway's credential (${res.status}). Check the header saved for it.`, { status: res.status });
      if (res.status === 202 || message.id === undefined) return { res, reply: null };
      if (!res.ok) {
        const text = (await res.text().catch(() => "")).slice(0, 300);
        throw new McpError(`The MCP server answered ${res.status}${text ? `: ${text}` : ""}.`, { status: res.status });
      }
      const type = String(res.headers.get("content-type") || "");
      const reply = type.includes("text/event-stream") ? await readSse(res, message.id) : await res.json();
      return { res, reply };
    } finally {
      clearTimeout(timer);
    }
  }

  /** The JSON-RPC response to `id` from an SSE stream (server requests and notifications are skipped). */
  async function readSse(res, id) {
    let found = null;
    const reader = createSseReader((_event, data) => {
      if (found) return;
      try {
        const msgs = [].concat(JSON.parse(data));
        found = msgs.find((m) => m && m.id === id && ("result" in m || "error" in m)) || null;
      } catch {
        /* not JSON */
      }
    });
    for await (const chunk of res.body) {
      reader.push(Buffer.from(chunk));
      if (found) break;
    }
    if (!found) reader.end();
    if (!found) throw new McpError("The MCP server's stream ended without an answer.");
    return found;
  }

  async function initialize() {
    if (initializing) return initializing;
    initializing = (async () => {
      session = null;
      const { res, reply } = await post(
        { jsonrpc: "2.0", id: nextId++, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "sparkDash AI gateway", version } } },
        { timeoutMs: INIT_TIMEOUT_MS, sessionHeaders: false }
      );
      if (reply?.error) throw new McpError(`The MCP server refused to start a session: ${reply.error.message}`, { rpc: reply.error });
      const protocol = reply?.result?.protocolVersion || PROTOCOL_VERSION;
      session = { id: res.headers.get("mcp-session-id"), protocol };
      await post({ jsonrpc: "2.0", method: "notifications/initialized" }, { timeoutMs: INIT_TIMEOUT_MS });
      return reply?.result || {};
    })();
    try {
      return await initializing;
    } finally {
      initializing = null;
    }
  }

  /** One request, with a session (made on first use, re-made once if it expired). */
  async function request(method, params, timeoutMs = CALL_TIMEOUT_MS) {
    if (!session) await initialize();
    const send = () => post({ jsonrpc: "2.0", id: nextId++, method, params }, { timeoutMs });
    let r;
    try {
      r = await send();
    } catch (err) {
      if (!err.expired) throw err;
      await initialize();
      r = await send();
    }
    if (r.reply?.error) throw new McpError(r.reply.error.message || "The MCP server returned an error.", { rpc: r.reply.error });
    return r.reply?.result;
  }

  async function listTools() {
    const tools = [];
    let cursor;
    for (let page = 0; page < 50; page++) {
      const r = await request("tools/list", cursor ? { cursor } : {}, INIT_TIMEOUT_MS * 3);
      tools.push(...(Array.isArray(r?.tools) ? r.tools : []));
      cursor = r?.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  return {
    initialize,
    listTools,
    callTool: (name, args) => request("tools/call", { name, arguments: args ?? {} }),
    /** For tests: forget the session as if the Gateway restarted. */
    reset: () => (session = null),
    get sessionId() {
      return session?.id ?? null;
    },
  };
}
