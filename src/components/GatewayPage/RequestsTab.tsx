// Onyx: Requests tab: the request log with filters, a request's details, its captured content
// (each view is audited with the viewer's name), and a JSONL export of metadata.
import { useCallback, useEffect, useState } from "react";
import { relativeTime } from "../PeoplePage/relativeTime";
import { exportRequests, fetchRequestContent, fetchRequests, tokens, usd, type CapturedContent, type RequestFilter, type RequestRow } from "./gatewayApi";

const STATUS: { key: NonNullable<RequestFilter["status"]>; label: string }[] = [
  { key: "", label: "All" },
  { key: "ok", label: "OK" },
  { key: "error", label: "Errors" },
  { key: "flagged", label: "Guardrail hits" },
  { key: "blocked", label: "Blocked" },
  { key: "refused", label: "Over budget" },
];

function statusChip(r: RequestRow) {
  if (r.usageState === "blocked") return <span className="gw-chip gw-chip--bad">Blocked</span>;
  if (r.usageState === "refused") return <span className="gw-chip gw-chip--warn">Over budget</span>;
  if (r.status == null) return <span className="gw-chip gw-chip--warn">{r.error === "client closed" ? "Client closed" : "No answer"}</span>;
  return <span className={`gw-chip ${r.status < 400 && !r.error ? "gw-chip--ok" : "gw-chip--bad"}`}>{r.status}</span>;
}

function cost(r: RequestRow) {
  if (r.costBasis === "subscription") return "Subscription";
  if (r.costUsd != null) return `${usd(r.costUsd)}${r.costBasis === "local" ? " est." : ""}`;
  if (r.costBasis === "local" && r.usageState === "ok") return "Estimating…";
  return "-";
}

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Pretty-print JSON bodies; SSE and anything else as-is. */
function pretty(text: string | null) {
  if (!text) return "";
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function Detail({ r, onClose }: { r: RequestRow; onClose: () => void }) {
  const [content, setContent] = useState<CapturedContent | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const view = async () => {
    setConfirming(false);
    try {
      setContent((await fetchRequestContent(r.id)).content);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const facts: [string, string][] = [
    ["When", new Date(r.ts).toLocaleString()],
    ["Who", `${r.identity}${r.device ? ` on ${r.device}` : ""} (${r.via})`],
    ["Client", r.client ?? "-"],
    ["Model", `${r.model ?? "-"} · ${r.format ?? ""}${r.stream ? " · streamed" : ""}`],
    ["Status", `${r.status ?? "none"}${r.error ? ` · ${r.error}` : ""}`],
    ["Timing", `${r.latencyMs ?? "-"} ms total, ${r.ttfbMs ?? "-"} ms to first byte`],
    ["Tokens", `${tokens(r.inTok)} in, ${tokens(r.outTok)} out, ${tokens(r.cacheReadTok)} cache read, ${tokens(r.cacheWriteTok)} cache write${r.partial ? " (partial)" : ""}`],
    ["Cost", cost(r)],
    ["Session", [r.sessionId, r.agentId].filter(Boolean).join(" · agent ") || "-"],
  ];
  return (
    <div className="gw-overlay" role="presentation" onClick={onClose}>
      <div className="panel gw-dialog gw-dialog--wide" role="dialog" aria-modal="true" aria-label={`Request ${r.id}`} onClick={(e) => e.stopPropagation()}>
        <div className="gw-section__head">
          <h2 className="gw-h2">Request {r.id}</h2>
          <button type="button" className="btn btn--sm btn--ghost" onClick={onClose}>
            Close
          </button>
        </div>
        <dl className="gw-dl">
          {facts.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd className={k === "Session" || k === "Model" ? "mono" : undefined}>{v}</dd>
            </div>
          ))}
          {r.guardrailHits.length ? (
            <div>
              <dt>Guardrails</dt>
              <dd>{r.guardrailHits.map((h) => `${h.name}: ${h.action}${h.count > 1 ? ` ×${h.count}` : ""}${h.tools ? ` (${h.tools.join(", ")})` : ""}`).join("; ")}</dd>
            </div>
          ) : null}
          {Object.keys(r.headers).length ? (
            <div>
              <dt>Headers</dt>
              <dd className="mono gw-small">
                {Object.entries(r.headers).map(([k, v]) => (
                  <div key={k}>
                    {k}: {v}
                  </div>
                ))}
              </dd>
            </div>
          ) : null}
        </dl>
        {r.hasContent ? (
          content ? (
            <div className="gw-content">
              <h3 className="gw-h3">Request{content.requestTruncated ? " (first 2 MB)" : ""}</h3>
              <pre className="mono gw-pre">{pretty(content.request)}</pre>
              <h3 className="gw-h3">Response{content.responseTruncated ? " (first 2 MB)" : ""}</h3>
              <pre className="mono gw-pre">{pretty(content.response) || "No response was stored."}</pre>
            </div>
          ) : confirming ? (
            <div className="gw-inline gw-confirm" role="alertdialog" aria-label="View captured content">
              <p>Your name, this request and the time are written to the audit trail and shown in Activity.</p>
              <div className="gw-row">
                <button type="button" className="btn btn--sm btn--primary" onClick={() => void view()}>
                  View content
                </button>
                <button type="button" className="btn btn--sm btn--ghost" onClick={() => setConfirming(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="btn btn--sm" onClick={() => setConfirming(true)}>
              View content…
            </button>
          )
        ) : (
          <p className="gw-muted gw-small">No content stored for this request. Full capture was off, or its content has passed retention.</p>
        )}
        {error ? <p className="gw-bad">{error}</p> : null}
      </div>
    </div>
  );
}

export function RequestsTab() {
  const [filter, setFilter] = useState<RequestFilter>({ status: "", range: "" });
  const [rows, setRows] = useState<RequestRow[] | null>(null);
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState<RequestRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(
    (append = false, before?: number) => {
      fetchRequests({ ...filter, before, limit: 100 }).then(
        (r) => {
          setRows((cur) => (append && cur ? [...cur, ...r.requests] : r.requests));
          setMore(r.more);
          setError(null);
        },
        (e) => setError(e instanceof Error ? e.message : String(e))
      );
    },
    [filter]
  );
  useEffect(() => load(), [load]);

  const doExport = async () => {
    setExporting(true);
    try {
      const span = { "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 }[filter.range || "30d"] ?? 30 * 86_400_000;
      const to = Date.now();
      const r = await exportRequests(to - span, to);
      download(`gateway-requests-${new Date(to).toISOString().slice(0, 10)}.jsonl`, r.jsonl, "application/x-ndjson");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="gw-tab">
      {error ? <p className="gw-bad">{error}</p> : null}
      <div className="gw-section__head gw-controls">
        <div className="seg" role="group" aria-label="Show">
          {STATUS.map((s) => (
            <button key={s.key} type="button" className={filter.status === s.key ? "is-on" : undefined} aria-pressed={filter.status === s.key} onClick={() => setFilter({ ...filter, status: s.key })}>
              {s.label}
            </button>
          ))}
        </div>
        <select className="field-input" aria-label="Range" value={filter.range} onChange={(e) => setFilter({ ...filter, range: e.target.value as RequestFilter["range"] })}>
          <option value="">Any time</option>
          <option value="24h">24 hours</option>
          <option value="7d">7 days</option>
          <option value="30d">30 days</option>
        </select>
        <input className="field-input" placeholder="Person" aria-label="Filter by person" defaultValue={filter.identity} onKeyDown={(e) => e.key === "Enter" && setFilter({ ...filter, identity: (e.target as HTMLInputElement).value.trim() || undefined })} />
        <input className="field-input mono" placeholder="Model" aria-label="Filter by model" defaultValue={filter.model} onKeyDown={(e) => e.key === "Enter" && setFilter({ ...filter, model: (e.target as HTMLInputElement).value.trim() || undefined })} />
        <button type="button" className="btn btn--sm" disabled={exporting} onClick={() => void doExport()} title="Request metadata only, never content">
          {exporting ? "Exporting…" : "Export JSONL"}
        </button>
      </div>
      <section className="panel gw-section" aria-label="Request log">
        {rows && rows.length === 0 ? <p className="gw-muted">No requests match. Point a tool at the gateway from the Connect page and requests appear here.</p> : null}
        {rows && rows.length ? (
          <div className="gw-scroll">
            <table className="gw-table gw-table--click">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>Model</th>
                  <th>Client</th>
                  <th>Status</th>
                  <th className="num">Tokens</th>
                  <th className="num">Cost</th>
                  <th className="num">Latency</th>
                  <th aria-label="Notes" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} tabIndex={0} onClick={() => setOpen(r)} onKeyDown={(e) => e.key === "Enter" && setOpen(r)}>
                    <td title={new Date(r.ts).toLocaleString()}>{relativeTime(r.ts)}</td>
                    <td>{r.identity}</td>
                    <td className="mono">{r.model}</td>
                    <td>{r.client}</td>
                    <td>{statusChip(r)}</td>
                    <td className="num">{r.inTok == null && r.outTok == null ? "-" : tokens((r.inTok ?? 0) + (r.outTok ?? 0) + (r.cacheReadTok ?? 0) + (r.cacheWriteTok ?? 0))}</td>
                    <td className="num">{cost(r)}</td>
                    <td className="num">{r.latencyMs != null ? `${(r.latencyMs / 1000).toFixed(1)} s` : "-"}</td>
                    <td>
                      {r.guardrailHits.length ? <span className="gw-chip gw-chip--warn" title={r.guardrailHits.map((h) => `${h.name}: ${h.action}`).join("; ")}>Guardrail</span> : null}
                      {r.hasContent ? <span className="gw-chip" title="Content stored">Content</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {more && rows ? (
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => load(true, rows.at(-1)!.id)}>
            Older requests
          </button>
        ) : null}
      </section>
      {open ? <Detail r={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}
