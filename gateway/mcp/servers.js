// Onyx Gateway: the remote MCP servers an Admin adds. URL plus an optional credential header
// (write-only, encrypted), Test and save (initialize + tools/list: "Connected. 18 tools."), and a
// cached tool list per server. One upstream session per server.
import { createMcpClient } from "./client.js";

const TOOLS_FRESH_MS = 60_000;
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export class McpServerError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** A server name from its URL: "https://mcp.github.com/x" -> "github". */
export function nameFromUrl(raw) {
  try {
    const host = new URL(raw).hostname.toLowerCase().replace(/^(www|mcp|api)\./, "");
    const first = host.split(".")[0] || "mcp";
    return first.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "mcp";
  } catch {
    return "mcp";
  }
}

const last4 = (s) => (s && s.length > 8 ? s.slice(-4) : null);

export class McpServers {
  /**
   * @param {import("better-sqlite3").Database} db
   * @param {{ vault: { seal: Function, open: Function }, audit?: Function, now?: () => number, fetchImpl?: typeof fetch, checkUrl?: (u: string) => Promise<string | null>, version?: string }} deps
   */
  constructor(db, { vault, audit, now = Date.now, fetchImpl = fetch, checkUrl = async () => null, version = "0" }) {
    this.db = db;
    this.vault = vault;
    this.audit = audit || (() => {});
    this.now = now;
    this.fetchImpl = fetchImpl;
    this.checkUrl = checkUrl;
    this.version = version;
    this.clients = new Map();
    this.refreshing = new Map();
  }

  // ─── Reading ────────────────────────────────────────────
  present(r) {
    const tools = JSON.parse(r.tools || "[]");
    return {
      id: r.id,
      name: r.name,
      url: r.url,
      enabled: Boolean(r.enabled),
      status: r.status === "working" ? "Connected" : r.status === "failing" ? "Failing" : "Not tested",
      lastError: r.last_error,
      lastTestedAt: r.last_tested_at,
      toolCount: tools.length,
      tools: tools.map((t) => t.name),
      headerName: r.header_name,
      headerLast4: r.header_last4,
      addedBy: r.added_by,
      addedAt: r.added_at,
    };
  }

  list() {
    return this.db.prepare("SELECT * FROM mcp_servers ORDER BY name").all().map((r) => this.present(r));
  }

  #row(id) {
    const r = this.db.prepare("SELECT * FROM mcp_servers WHERE id = ?").get(id);
    if (!r) throw new McpServerError(404, "That MCP server no longer exists.");
    return r;
  }

  #headers(r) {
    if (!r.header_name) return {};
    const s = this.db.prepare("SELECT ciphertext FROM mcp_secrets WHERE server_id = ?").get(r.id);
    return s ? { [r.header_name.toLowerCase()]: this.vault.open(s.ciphertext) } : {};
  }

  /** The upstream client for a server (one session each). */
  client(r) {
    let c = this.clients.get(r.id);
    if (!c) {
      c = createMcpClient({ url: r.url, headers: this.#headers(r), fetchImpl: this.fetchImpl, version: this.version });
      this.clients.set(r.id, c);
    }
    return c;
  }

  // ─── Test and save ──────────────────────────────────────
  async #probe(url, headers) {
    const c = createMcpClient({ url, headers, fetchImpl: this.fetchImpl, version: this.version });
    const init = await c.initialize();
    const tools = await c.listTools();
    return { tools, serverName: init?.serverInfo?.name || null };
  }

  #validateHeader(headerName) {
    const n = String(headerName || "").trim();
    if (!n) return null;
    if (!/^[A-Za-z0-9-]{1,64}$/.test(n)) throw new McpServerError(400, "A header name is letters, digits and dashes, such as Authorization.");
    if (/^(host|content-length|content-type|accept|mcp-session-id|mcp-protocol-version|cookie)$/i.test(n)) throw new McpServerError(400, `The Gateway sets ${n} itself; use the header the server expects for its credential.`);
    return n;
  }

  /**
   * Add a server: test it (initialize and tools/list), then save. Saving untested is allowed.
   * @param {{ name?: string, url: string, headerName?: string, headerValue?: string, saveAnyway?: boolean }} b
   */
  async add(b, actor) {
    const url = String(b.url || "").trim();
    const problem = await this.checkUrl(url);
    if (problem) throw new McpServerError(400, problem);
    const name = String(b.name || nameFromUrl(url)).trim().toLowerCase();
    if (!NAME_RE.test(name)) throw new McpServerError(400, "A server name is lowercase letters, digits and dashes (it prefixes tool names, as name__tool).");
    if (this.db.prepare("SELECT 1 FROM mcp_servers WHERE name = ?").get(name)) throw new McpServerError(409, `There's already a server named ${name}. Pick another name.`);
    const headerName = this.#validateHeader(b.headerName ?? (b.headerValue ? "Authorization" : ""));
    const headerValue = headerName ? String(b.headerValue || "") : "";
    if (headerName && !headerValue) throw new McpServerError(400, `Enter the value for ${headerName}, or leave both empty.`);
    let tools = [];
    let status = "not_tested";
    let lastError = null;
    let message;
    let details;
    try {
      ({ tools } = await this.#probe(url, headerName ? { [headerName.toLowerCase()]: headerValue } : {}));
      status = "working";
      message = `Connected. ${tools.length} tool${tools.length === 1 ? "" : "s"}.`;
    } catch (err) {
      lastError = String(err.message || err).slice(0, 500);
      if (!b.saveAnyway) return { saved: false, ok: false, message: `Couldn't connect: ${lastError}`, details: lastError };
      status = "failing";
      message = `Saved, but it isn't working yet: ${lastError}`;
      details = lastError;
    }
    const id = Number(
      this.db
        .prepare("INSERT INTO mcp_servers (name, url, enabled, status, last_error, last_tested_at, tools, tools_at, header_name, header_last4, added_by, added_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(name, url, status, lastError, this.now(), JSON.stringify(tools), this.now(), headerName, last4(headerValue), actor, this.now()).lastInsertRowid
    );
    if (headerName) this.db.prepare("INSERT INTO mcp_secrets (server_id, ciphertext) VALUES (?, ?)").run(id, this.vault.seal(headerValue));
    this.audit(actor, "mcp.server_added", name, `${tools.length} tools`);
    return { saved: true, ok: status === "working", message, details, server: this.present(this.#row(id)) };
  }

  async retest(id) {
    const r = this.#row(id);
    this.clients.delete(id);
    try {
      const { tools } = await this.#probe(r.url, this.#headers(r));
      this.db.prepare("UPDATE mcp_servers SET status = 'working', last_error = NULL, last_tested_at = ?, tools = ?, tools_at = ? WHERE id = ?").run(this.now(), JSON.stringify(tools), this.now(), id);
      return { ok: true, message: `Connected. ${tools.length} tool${tools.length === 1 ? "" : "s"}.`, server: this.present(this.#row(id)) };
    } catch (err) {
      const e = String(err.message || err).slice(0, 500);
      this.db.prepare("UPDATE mcp_servers SET status = 'failing', last_error = ?, last_tested_at = ? WHERE id = ?").run(e, this.now(), id);
      return { ok: false, message: `Couldn't connect: ${e}`, details: e, server: this.present(this.#row(id)) };
    }
  }

  /** Switch a server on or off, or replace its credential (tested before the old one is dropped). */
  async update(id, b, actor) {
    const r = this.#row(id);
    if (b.enabled !== undefined) {
      this.db.prepare("UPDATE mcp_servers SET enabled = ? WHERE id = ?").run(b.enabled ? 1 : 0, id);
      this.audit(actor, "mcp.server_enabled", r.name, b.enabled ? "on" : "off");
    }
    if (b.headerValue !== undefined) {
      const headerName = this.#validateHeader(b.headerName ?? r.header_name ?? "Authorization");
      const value = String(b.headerValue || "");
      const headers = headerName && value ? { [headerName.toLowerCase()]: value } : {};
      try {
        await this.#probe(r.url, headers);
      } catch (err) {
        return { ok: false, message: `The new credential didn't work, so the old one is kept: ${String(err.message || err).slice(0, 300)}`, server: this.present(r) };
      }
      this.db.prepare("UPDATE mcp_servers SET header_name = ?, header_last4 = ? WHERE id = ?").run(value ? headerName : null, last4(value), id);
      this.db.prepare("DELETE FROM mcp_secrets WHERE server_id = ?").run(id);
      if (value) this.db.prepare("INSERT INTO mcp_secrets (server_id, ciphertext) VALUES (?, ?)").run(id, this.vault.seal(value));
      this.clients.delete(id);
      this.audit(actor, "mcp.credential_replaced", r.name, value ? `${headerName} …${last4(value) ?? ""}` : "removed");
      return { ...(await this.retest(id)), replaced: true };
    }
    return { ok: true, server: this.present(this.#row(id)) };
  }

  remove(id, actor) {
    const r = this.#row(id);
    this.db.prepare("DELETE FROM mcp_servers WHERE id = ?").run(id);
    this.clients.delete(id);
    this.audit(actor, "mcp.server_removed", r.name, null);
  }

  // ─── Serving ────────────────────────────────────────────
  /** Every enabled server's tools, refreshed when older than a minute (falls back to the cache). */
  async allTools() {
    const rows = this.db.prepare("SELECT * FROM mcp_servers WHERE enabled = 1 ORDER BY name").all();
    await Promise.all(rows.filter((r) => this.now() - (r.tools_at || 0) > TOOLS_FRESH_MS).map((r) => this.#refresh(r)));
    return this.db
      .prepare("SELECT * FROM mcp_servers WHERE enabled = 1 ORDER BY name")
      .all()
      .flatMap((r) => JSON.parse(r.tools || "[]").map((tool) => ({ server: r.name, serverId: r.id, tool })));
  }

  #refresh(r) {
    if (this.refreshing.has(r.id)) return this.refreshing.get(r.id);
    const p = (async () => {
      try {
        const tools = await this.client(r).listTools();
        this.db.prepare("UPDATE mcp_servers SET tools = ?, tools_at = ?, status = 'working', last_error = NULL WHERE id = ?").run(JSON.stringify(tools), this.now(), r.id);
      } catch (err) {
        this.db.prepare("UPDATE mcp_servers SET tools_at = ?, status = 'failing', last_error = ? WHERE id = ?").run(this.now(), String(err.message || err).slice(0, 500), r.id);
      }
    })().finally(() => this.refreshing.delete(r.id));
    this.refreshing.set(r.id, p);
    return p;
  }

  /** Does a server offer a tool? Checks the cache, then the server itself once (a tool added since). */
  async hasTool(r, tool) {
    const has = (row) => JSON.parse(row.tools || "[]").some((t) => t.name === tool);
    if (has(r)) return true;
    await this.#refresh(r);
    return has(this.#row(r.id));
  }

  byName(name) {
    return this.db.prepare("SELECT * FROM mcp_servers WHERE name = ? AND enabled = 1").get(name) || null;
  }

  /** The value of a server's credential, for redacting it from errors. Internal only. */
  secretOf(r) {
    return Object.values(this.#headers(r))[0] || "";
  }
}
