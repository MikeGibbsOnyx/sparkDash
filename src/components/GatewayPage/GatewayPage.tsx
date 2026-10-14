// Onyx: AI Gateway page: first-run card until set up, then Overview, Models and Access tabs.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useRole } from "../PeoplePage/AccessContext";
import { atLeast } from "../PeoplePage/accessApi";
import { AccessTab } from "./AccessTab";
import { UsageTab } from "./UsageTab";
import { RequestsTab } from "./RequestsTab";
import { PrivacyTab } from "./PrivacyTab";
import { McpTab } from "./McpTab";
import { AddProviderKey, ModelsTab } from "./ModelsTab";
import { enableGateway, fetchGatewayStatus, gatewayUrl, pauseGateway, publishGateway, setServe, fetchLocalServers, tokens, usd, type GatewayStatus, type LocalServer, type PublishState } from "./gatewayApi";
import "./gateway.css";

type Tab = "overview" | "models" | "access" | "usage" | "requests" | "privacy" | "mcp";

/** Open the AI Gateway page on a tab, from anywhere (after navigating to it). */
export function openGatewayTab(tab: Tab, extra = "") {
  try {
    window.history.replaceState(window.history.state, "", `/gateway?tab=${tab}${extra}`);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event("sparkdash:gateway-tab"));
}

function readTab(): { tab: Tab; newKey: boolean } {
  try {
    const q = new URLSearchParams(window.location.search);
    const t = q.get("tab");
    return { tab: t === "models" || t === "access" || t === "usage" || t === "requests" || t === "privacy" || t === "mcp" ? t : "overview", newKey: q.get("new") === "key" };
  } catch {
    return { tab: "overview", newKey: false };
  }
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="btn btn--sm" onClick={() => void navigator.clipboard?.writeText(text).then(() => (setDone(true), setTimeout(() => setDone(false), 1500)))}>
      {done ? "Copied" : label}
    </button>
  );
}

function PublishBlock({ publish, canEdit, onDone }: { publish: PublishState; canEdit: boolean; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ error: string; command: string } | null>(null);
  if (publish.published && publish.url) {
    return (
      <div className="gw-published">
        <span className="mono">{publish.url}</span>
        <CopyButton text={publish.url} label="Copy link" />
        <a className="btn btn--sm btn--ghost" href={publish.url} target="_blank" rel="noopener noreferrer">
          Open Connect page
        </a>
        {publish.funnel ? <p className="gw-bad gw-small">This address is on Tailscale Funnel, open to the internet. Turn Funnel off for port 8443; the gateway refuses Funnel requests.</p> : null}
      </div>
    );
  }
  return (
    <div className="gw-published">
      {publish.conflict ? <p className="gw-warn gw-small">{publish.conflict}</p> : null}
      {canEdit ? (
        <button
          type="button"
          className="btn btn--primary btn--sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await publishGateway();
              if (!r.ok) setMsg({ error: r.error || "Publishing didn't work.", command: r.command });
              onDone();
            } catch (e) {
              setMsg({ error: e instanceof Error ? e.message : String(e), command: publish.command });
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Publishing…" : "Publish on your tailnet"}
        </button>
      ) : (
        <p className="gw-muted">Not published on the tailnet yet.</p>
      )}
      {msg ? (
        <div className="gw-small">
          <p className="gw-bad">{msg.error}</p>
          <div className="gw-copyrow">
            <code className="mono">{msg.command}</code>
            <CopyButton text={msg.command} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Step({ n, done, title, children }: { n: number; done: boolean; title: string; children?: ReactNode }) {
  return (
    <li className={`gw-step ${done ? "is-done" : ""}`}>
      <span className="gw-step__n" aria-hidden>
        {done ? "✓" : n}
      </span>
      <div>
        <h3 className="gw-h3">
          {title}
          {done ? <span className="sr-only"> (done)</span> : null}
        </h3>
        {children}
      </div>
    </li>
  );
}

/** Before first use: three steps that tick off when done. */
function FirstRun({ status, canEdit, onChanged }: { status: GatewayStatus; canEdit: boolean; onChanged: () => void }) {
  const g = status.gateway;
  const on = g.up && g.enabled;
  const hasSource = g.up && (g.providers > 0 || g.localServed > 0);
  const published = status.publish.published;
  const [servers, setServers] = useState<LocalServer[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (on) fetchLocalServers().then((r) => setServers(r.servers), () => {});
  }, [on, g]);
  return (
    <section className="panel gw-first" aria-label="Set up the AI gateway">
      <h2 className="gw-h2">Set up the AI gateway</h2>
      <p className="gw-muted">One address for every AI tool on your team. Provider keys stay on this machine; laptops hold none.</p>
      <ol className="gw-steps">
        <Step n={1} done={on} title="Turn on the gateway">
          {!on && canEdit ? (
            <button type="button" className="btn btn--primary btn--sm" onClick={() => void enableGateway().then(onChanged, (e) => setError(String(e?.message || e)))}>
              Turn on
            </button>
          ) : null}
          {!on ? <p className="gw-muted gw-small">Creates the grant “Everyone → all models”. Budgets, guardrails and request capture stay off until you change them.</p> : null}
        </Step>
        <Step n={2} done={hasSource} title="Add a model source">
          {on && !hasSource && canEdit ? (
            <>
              <AddProviderKey compact onSaved={onChanged} />
              {servers.length ? (
                <ul className="gw-list">
                  {servers.map((s) => (
                    <li key={s.id}>
                      <span>
                        {s.machine} :{s.port} <span className="gw-muted">{s.models.join(", ")}</span>
                      </span>
                      <label className="gw-switch">
                        <input type="checkbox" checked={s.serve} disabled={!s.reachable} onChange={(e) => void setServe(s.id, e.target.checked).then(onChanged)} />
                        Serve through the gateway
                      </label>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : null}
        </Step>
        <Step n={3} done={published} title="Publish and share">
          {on && hasSource ? <PublishBlock publish={status.publish} canEdit={canEdit} onDone={onChanged} /> : null}
        </Step>
      </ol>
      {error ? <p className="gw-bad">{error}</p> : null}
    </section>
  );
}

function Overview({ status, canEdit, onChanged }: { status: GatewayStatus; canEdit: boolean; onChanged: () => void }) {
  const g = status.gateway;
  if (!g.up) return null;
  return (
    <div className="gw-tab">
      <section className="panel gw-section">
        <div className="gw-section__head">
          <h2 className="gw-h2">
            <i className={`sdot ${g.enabled ? "" : "sdot--warn"}`} aria-hidden /> {g.enabled ? "On" : "Paused"}
          </h2>
          {canEdit ? (
            g.enabled ? (
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => window.confirm("Pause the gateway? Every request gets a 503 until you turn it back on.") && void pauseGateway().then(onChanged)}>
                Pause
              </button>
            ) : (
              <button type="button" className="btn btn--sm btn--primary" onClick={() => void enableGateway().then(onChanged)}>
                Turn on
              </button>
            )
          ) : null}
        </div>
        <PublishBlock publish={status.publish} canEdit={canEdit} onDone={onChanged} />
        <div className="gw-kpis">
          <div>
            <b>{usd((g.today.cloudUsd ?? 0) + (g.today.localUsd ?? 0))}</b>
            <span>spent today</span>
          </div>
          <div>
            <b>{g.today.requests}</b>
            <span>requests today</span>
          </div>
          <div>
            <b>{g.today.people}</b>
            <span>people today</span>
          </div>
          <div>
            <b>{g.today.errors}</b>
            <span>errors today</span>
          </div>
          <div>
            <b>{g.models}</b>
            <span>models available</span>
          </div>
        </div>
        <p className="gw-muted gw-small">
          Today in {g.timeZone}: cloud {usd(g.today.cloudUsd ?? 0)}, local energy {usd(g.today.localUsd ?? 0)} (estimate), {tokens(g.today.tokens ?? 0)} tokens.{" "}
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => openGatewayTab("usage")}>
            Open Usage
          </button>
        </p>
      </section>
      <div className="gw-two">
        <section className="panel gw-section" aria-label="Top people today">
          <h3 className="gw-h3">Top people today</h3>
          {g.today.topPeople.length ? (
            <ul className="gw-list gw-list--tight">
              {g.today.topPeople.map((p) => (
                <li key={p.identity}>
                  <span>{p.identity}</span>
                  <span className="mono">{p.requests}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="gw-muted">No requests yet today.</p>
          )}
        </section>
        <section className="panel gw-section" aria-label="Top models today">
          <h3 className="gw-h3">Top models today</h3>
          {g.today.topModels.length ? (
            <ul className="gw-list gw-list--tight">
              {g.today.topModels.map((m) => (
                <li key={m.model}>
                  <span className="mono">{m.model}</span>
                  <span className="mono">{m.requests}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="gw-muted">No requests yet today.</p>
          )}
        </section>
      </div>
      {g.findings.length ? (
        <section className="panel gw-section" aria-label="Findings">
          <h3 className="gw-h3">Needs attention</h3>
          <ul className="gw-list">
            {g.findings.map((f) => (
              <li key={f.id}>
                <div>
                  <b className={f.severity === "warn" ? "gw-warn" : undefined}>{f.title}</b>
                  {f.detail ? <div className="gw-small gw-muted">{f.detail}</div> : null}
                  <div className="gw-small">{f.hint}</div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {status.publish.funnel ? (
        <section className="panel gw-section gw-bad" role="alert">
          The gateway's port is on Tailscale Funnel. Turn Funnel off: <code className="mono">sudo tailscale funnel --https=8443 off</code>
        </section>
      ) : null}
    </div>
  );
}

export function GatewayPage() {
  const role = useRole();
  const canEdit = atLeast(role, "admin");
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [{ tab, newKey }, setRoute] = useState(readTab);

  const load = useCallback(() => {
    fetchGatewayStatus()
      .then((s) => {
        setStatus(s);
        setError(null);
        // Keep the sidebar's status dot in step with what this page just saw.
        window.dispatchEvent(new CustomEvent("sparkdash:gateway-status", { detail: s }));
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  // The command palette can open a tab directly (Add provider key, New gateway key).
  useEffect(() => {
    const onTab = () => setRoute(readTab());
    window.addEventListener("sparkdash:gateway-tab", onTab);
    return () => window.removeEventListener("sparkdash:gateway-tab", onTab);
  }, []);

  const go = (t: Tab) => {
    setRoute({ tab: t, newKey: false });
    try {
      const u = new URL(window.location.href);
      if (t === "overview") u.searchParams.delete("tab");
      else u.searchParams.set("tab", t);
      u.searchParams.delete("new");
      window.history.replaceState(window.history.state, "", u);
    } catch {
      /* ignore */
    }
  };

  const g = status?.gateway;
  const setUp = g?.up && g.enabled && (g.providers > 0 || g.localServed > 0) && status?.publish.published;

  return (
    <div className="gw">
      <header className="page-head">
        <div>
          <h1>AI Gateway</h1>
          <p className="page-head__sub">One address for Claude Code, Codex, Gemini CLI and other AI tools. Tailscale identifies each person; provider keys never leave this machine.</p>
        </div>
      </header>
      {error && !status ? <p className="gw-bad">{error}</p> : null}
      {g && !g.up ? (
        <section className="panel gw-section" role="alert">
          <h2 className="gw-h2">The gateway isn't running</h2>
          <p>{g.error}</p>
          <div className="gw-copyrow">
            <code className="mono">docker compose up -d gateway</code>
            <CopyButton text="docker compose up -d gateway" />
          </div>
        </section>
      ) : null}
      {status && g?.up && !setUp ? <FirstRun status={status} canEdit={canEdit} onChanged={load} /> : null}
      {status && g?.up && (g.enabled || g.providers > 0) ? (
        <>
          <nav className="gw-tabs" role="tablist" aria-label="AI Gateway">
            {(
              [
                ["overview", "Overview"],
                ["models", "Models"],
                ["access", "Access"],
                ["usage", "Usage"],
                ["requests", "Requests"],
                ["privacy", "Privacy and guardrails"],
                ["mcp", "MCP"],
              ] as const
            ).map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "is-on" : ""} onClick={() => go(id)}>
                {label}
              </button>
            ))}
          </nav>
          {tab === "overview" ? <Overview status={status} canEdit={canEdit} onChanged={load} /> : null}
          {tab === "models" ? <ModelsTab canEdit={canEdit} onChanged={load} /> : null}
          {tab === "access" ? <AccessTab canEdit={canEdit} url={gatewayUrl(status)} startNewKey={newKey} /> : null}
          {tab === "usage" ? <UsageTab /> : null}
          {tab === "requests" ? <RequestsTab /> : null}
          {tab === "privacy" ? <PrivacyTab canEdit={canEdit} /> : null}
          {tab === "mcp" ? <McpTab canEdit={canEdit} url={gatewayUrl(status)} /> : null}
        </>
      ) : null}
      {!canEdit && status ? <p className="gw-muted gw-small">You can view this page but not change it.</p> : null}
    </div>
  );
}
