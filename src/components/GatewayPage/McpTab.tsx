// Onyx: MCP tab: the remote MCP servers the gateway combines at /mcp. Add one (URL and an optional
// credential header, then Test and save), see its tools, test, replace the credential, remove.
import { useCallback, useEffect, useState } from "react";
import { relativeTime } from "../PeoplePage/relativeTime";
import { addMcpServer, fetchMcpServers, removeMcpServer, testMcpServer, updateMcpServer, type McpSaveResult, type McpServer } from "./gatewayApi";

function nameFromUrl(raw: string) {
  try {
    const host = new URL(raw).hostname.toLowerCase().replace(/^(www|mcp|api)\./, "");
    return (host.split(".")[0] || "mcp").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  } catch {
    return "";
  }
}

function Result({ r }: { r: McpSaveResult }) {
  return (
    <div className={`gw-result ${r.ok ? "gw-ok" : "gw-bad"}`} role="status">
      {r.ok ? "● " : ""}
      {r.message}
    </div>
  );
}

function AddServer({ onSaved }: { onSaved: () => void }) {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [headerName, setHeaderName] = useState("Authorization");
  const [headerValue, setHeaderValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<McpSaveResult | null>(null);
  const save = async (saveAnyway = false) => {
    setBusy(true);
    try {
      const r = await addMcpServer({ url: url.trim(), name: (name || nameFromUrl(url)).trim(), headerName: headerValue ? headerName.trim() : undefined, headerValue: headerValue || undefined, saveAnyway });
      setResult(r);
      if (r.saved) {
        setUrl("");
        setName("");
        setHeaderValue("");
        onSaved();
      }
    } catch (e) {
      setResult({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="panel gw-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h3 className="gw-h3">Add an MCP server</h3>
      <label>
        <span>URL</span>
        <input className="field-input mono" value={url} onChange={(e) => (setUrl(e.target.value), setResult(null))} placeholder="https://mcp.example.com/mcp" />
      </label>
      <label>
        <span>Name</span>
        <input className="field-input mono" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder={nameFromUrl(url) || "github"} />
      </label>
      <p className="gw-muted gw-small">Its tools appear as {(name || nameFromUrl(url) || "name") + "__<tool>"}; grants match those names.</p>
      <div className="gw-row gw-header-row">
        <label>
          <span>Credential header</span>
          <input className="field-input mono" value={headerName} onChange={(e) => setHeaderName(e.target.value)} aria-label="Header name" />
        </label>
        <label>
          <span>Value</span>
          <input type="password" className="field-input mono" autoComplete="off" value={headerValue} onChange={(e) => setHeaderValue(e.target.value)} placeholder="Bearer … (optional)" aria-label="Header value" />
        </label>
      </div>
      <p className="gw-muted gw-small">One credential for everyone, kept encrypted in the gateway and never shown again.</p>
      <div className="gw-row">
        <button type="submit" className="btn btn--primary btn--sm" disabled={busy || !url.trim()}>
          {busy ? "Testing…" : "Test and save"}
        </button>
        {result && !result.ok && !result.saved ? (
          <button type="button" className="btn btn--sm btn--ghost" disabled={busy} onClick={() => void save(true)}>
            Save anyway
          </button>
        ) : null}
      </div>
      {result ? <Result r={result} /> : null}
    </form>
  );
}

function ServerCard({ s, canEdit, onChanged }: { s: McpServer; canEdit: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<McpSaveResult | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [value, setValue] = useState("");
  const [showTools, setShowTools] = useState(false);
  const run = async (fn: () => Promise<McpSaveResult | unknown>) => {
    setBusy(true);
    try {
      const r = await fn();
      if (r && typeof r === "object" && "message" in r) setResult(r as McpSaveResult);
      onChanged();
    } catch (e) {
      setResult({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  const tone = s.status === "Connected" ? "gw-chip--ok" : s.status === "Failing" ? "gw-chip--bad" : "gw-chip--warn";
  return (
    <article className="panel gw-card" aria-label={`MCP server ${s.name}`}>
      <header className="gw-card__head">
        <b className="mono">{s.name}</b>
        <span className={`gw-chip ${tone}`}>{s.enabled ? s.status : "Off"}</span>
      </header>
      <div className="mono gw-small gw-key">{s.url}</div>
      <dl className="gw-facts">
        <div>
          {s.toolCount} tool{s.toolCount === 1 ? "" : "s"}{" "}
          {s.toolCount ? (
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => setShowTools(!showTools)}>
              {showTools ? "Hide" : "Show"}
            </button>
          ) : null}
        </div>
        {showTools ? <div className="mono gw-small">{s.tools.map((t) => `${s.name}__${t}`).join(", ")}</div> : null}
        <div>{s.headerName ? `${s.headerName}: …${s.headerLast4 ?? ""}` : "No credential"}</div>
        <div>
          Added {new Date(s.addedAt).toLocaleDateString()} by {s.addedBy || "unknown"}
          {s.lastTestedAt ? ` · checked ${relativeTime(s.lastTestedAt)}` : ""}
        </div>
        {s.status === "Failing" && s.lastError ? <div className="gw-bad">{s.lastError}</div> : null}
      </dl>
      <label className="gw-switch">
        <input type="checkbox" checked={s.enabled} disabled={!canEdit || busy} onChange={(e) => void run(() => updateMcpServer(s.id, { enabled: e.target.checked }))} /> Offer its tools at /mcp
      </label>
      {canEdit ? (
        replacing ? (
          <div className="gw-inline">
            <input type="password" className="field-input mono" autoFocus autoComplete="off" placeholder={`New ${s.headerName || "Authorization"} value`} value={value} onChange={(e) => setValue(e.target.value)} aria-label="New credential" />
            <div className="gw-row">
              <button type="button" className="btn btn--sm btn--primary" disabled={busy || !value} onClick={() => void run(() => updateMcpServer(s.id, { headerName: s.headerName || "Authorization", headerValue: value })).then(() => (setReplacing(false), setValue("")))}>
                {busy ? "Testing…" : "Test and replace"}
              </button>
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => setReplacing(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="gw-row">
            <button type="button" className="btn btn--sm" disabled={busy} onClick={() => void run(() => testMcpServer(s.id))}>
              {busy ? "Testing…" : "Test"}
            </button>
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => (setReplacing(true), setResult(null))}>
              Replace credential
            </button>
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => window.confirm(`Remove ${s.name}? Its tools disappear from everyone's /mcp at once.`) && void run(() => removeMcpServer(s.id))}>
              Remove
            </button>
          </div>
        )
      ) : null}
      {result ? <Result r={result} /> : null}
    </article>
  );
}

export function McpTab({ canEdit, url }: { canEdit: boolean; url: string }) {
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    fetchMcpServers().then(
      (r) => (setServers(r.servers), setError(null)),
      (e) => setError(e instanceof Error ? e.message : String(e))
    );
  }, []);
  useEffect(load, [load]);
  return (
    <div className="gw-tab">
      {error ? <p className="gw-bad">{error}</p> : null}
      <section className="panel gw-section" aria-label="MCP endpoint">
        <h2 className="gw-h2">One MCP endpoint for everyone</h2>
        <p className="gw-small">
          <span className="mono">{url}/mcp</span> combines the tools of every server below. Each person sees only the tools their grants allow (the MCP tools patterns on the Access tab), and every call is logged on the Requests tab. Upstream credentials never leave the gateway.
        </p>
        <p className="gw-muted gw-small">Remote servers over Streamable HTTP only; local (stdio) servers, resources and prompts aren't proxied.</p>
      </section>
      {canEdit ? <AddServer onSaved={load} /> : null}
      <div className="gw-cards">
        {(servers ?? []).map((s) => (
          <ServerCard key={s.id} s={s} canEdit={canEdit} onChanged={load} />
        ))}
      </div>
      {servers && servers.length === 0 ? <p className="gw-muted">No MCP servers yet. Add one above and its tools appear at /mcp.</p> : null}
    </div>
  );
}
