// Onyx: one URL on the tailnet: pick your tool, copy one block, watch your first request arrive.
import { useCallback, useEffect, useMemo, useState } from "react";
import { TOOLS, curlCheck, snippetFor, type Credential, type Os, type ToolId } from "./snippets";

type Me = {
  who: { kind: string; login: string | null; name: string | null; label: string; device: string | null; role: string | null; via: string };
  gatewayEnabled: boolean;
  models: { name: string; provider: string }[];
  lastRequest: { ts: number; client: string; model: string; status: number } | null;
  personalKeys: boolean;
  budgets?: MyBudget[];
};
type MyBudget = { id: number; name: string; period: string; limitUsd: number | null; limitTokens: number | null; spentUsd: number; spentTokens: number; resets: string; state: "ok" | "warning" | "exhausted"; warnPct: number };
type UsageRow = { model: string; requests: number; inTok: number; outTok: number; costUsd: number; subscriptionRequests: number };

const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const count = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n.toLocaleString("en-US"));

/** "Budget Sam monthly: $12.30 of $50.00 this month. Resets Nov 1." */
export function budgetLine(b: MyBudget): string {
  const used = [b.limitUsd != null ? `${money(b.spentUsd)} of ${money(b.limitUsd)}` : null, b.limitTokens != null ? `${count(b.spentTokens)} of ${count(b.limitTokens)} tokens` : null].filter(Boolean).join(", ");
  const head = b.state === "exhausted" ? `Budget ${b.name} is used up: ${used}. Requests are refused until it resets` : `Budget ${b.name}: ${used} this ${b.period}. Resets`;
  return `${head} ${b.resets}.`;
}
type Key = { id: number; name: string; prefix: string; expiresAt: number | null; lastUsedAt: number | null; state: string };

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init?.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message || body?.error || `HTTP ${res.status}`);
  return body as T;
}

export function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s} second${s === 1 ? "" : "s"} ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} hour${h === 1 ? "" : "s"} ago` : `${Math.round(h / 24)} days ago`;
}

function CopyBlock({ code, file, title, note }: { code: string; file?: string; title: string; note?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="cn-block">
      <div className="cn-block__head">
        <span>
          {title}
          {file ? <code className="cn-file">{file}</code> : null}
        </span>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => {
            void navigator.clipboard?.writeText(code).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="cn-code mono">{code}</pre>
      {note ? <p className="cn-note">{note}</p> : null}
    </div>
  );
}

export function ConnectPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tool, setTool] = useState<ToolId>("claude-code");
  const [os, setOs] = useState<Os>(() => (/Win/.test(navigator.platform) ? "windows" : "unix"));
  const [credential, setCredential] = useState<Credential>("own");
  const [, tick] = useState(0);
  const url = window.location.origin;

  const load = useCallback(() => {
    call<Me>("/me")
      .then((m) => {
        setMe(m);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => {
      load();
      tick((n) => n + 1);
    }, 3000);
    return () => clearInterval(t);
  }, [load]);

  const toolDef = TOOLS.find((t) => t.id === tool)!;
  const blocks = useMemo(() => snippetFor({ url, tool, os, credential: toolDef.own ? credential : "company", models: me?.models ?? [] }), [url, tool, os, credential, me, toolDef.own]);

  if (error && !me) {
    return (
      <main className="cn">
        <div className="panel cn-card" role="alert">
          <h1>You can't use the gateway from here</h1>
          <p>{error}</p>
        </div>
      </main>
    );
  }
  if (!me) return <main className="cn" aria-busy="true" />;

  const who = me.who.name || me.who.login || me.who.label;
  return (
    <main className="cn">
      <header className="cn-banner panel">
        <div>
          <h1>Connect to the AI gateway</h1>
          <p className="cn-sub">
            Signed in as <b>{who}</b>
            {me.who.device ? <> on {me.who.device}</> : null}. You can use {me.models.length} model{me.models.length === 1 ? "" : "s"}.
          </p>
          {(me.budgets ?? []).map((b) => (
            <p key={b.id} className={`cn-budget ${b.state === "exhausted" ? "cn-bad" : b.state === "warning" ? "cn-warn-text" : "cn-muted"}`}>
              {budgetLine(b)}
            </p>
          ))}
        </div>
        {me.who.role && me.who.role !== "member" ? (
          <a className="btn btn--sm" href={`${window.location.protocol}//${window.location.hostname}/`}>
            Open the dashboard
          </a>
        ) : null}
      </header>

      {!me.gatewayEnabled ? (
        <div className="panel cn-card cn-warn" role="status">
          The gateway is turned off right now. You can set up your tool; requests will work once an Admin turns it on.
        </div>
      ) : null}

      <section aria-label="Pick your tool">
        <h2 className="cn-h2">1. Pick your tool</h2>
        <div className="cn-tiles" role="radiogroup">
          {TOOLS.map((t) => (
            <button key={t.id} type="button" role="radio" aria-checked={tool === t.id} className={`cn-tile ${tool === t.id ? "is-on" : ""}`} onClick={() => setTool(t.id)}>
              <b>{t.label}</b>
              <span>{t.blurb}</span>
            </button>
          ))}
        </div>
      </section>

      <section aria-label="Copy the setup" className="cn-setup">
        <h2 className="cn-h2">2. Copy this</h2>
        <div className="cn-switches">
          {toolDef.own ? (
            <div className="cn-seg" role="radiogroup" aria-label="Which account pays">
              <button type="button" role="radio" aria-checked={credential === "own"} className={credential === "own" ? "is-on" : ""} onClick={() => setCredential("own")}>
                Use my own subscription
              </button>
              <button type="button" role="radio" aria-checked={credential === "company"} className={credential === "company" ? "is-on" : ""} onClick={() => setCredential("company")}>
                Use the company's key
              </button>
            </div>
          ) : null}
          <div className="cn-seg" role="radiogroup" aria-label="Operating system">
            <button type="button" role="radio" aria-checked={os === "unix"} className={os === "unix" ? "is-on" : ""} onClick={() => setOs("unix")}>
              macOS / Linux
            </button>
            <button type="button" role="radio" aria-checked={os === "windows"} className={os === "windows" ? "is-on" : ""} onClick={() => setOs("windows")}>
              Windows
            </button>
          </div>
        </div>
        {blocks.map((b) => (
          <CopyBlock key={b.title} {...b} />
        ))}
        <CopyBlock title="Check it" code={curlCheck(url, "sparkdash", os)} note="Lists the models you can use." />
      </section>

      <section aria-label="Connection" className="panel cn-card cn-live" role="status" aria-live="polite">
        <h2 className="cn-h2">3. Use it</h2>
        {me.lastRequest ? (
          <p>
            <i className={`cn-dot ${me.lastRequest.status && me.lastRequest.status < 400 ? "is-ok" : "is-bad"}`} aria-hidden />
            {me.lastRequest.status && me.lastRequest.status < 400 ? "Connected" : `Last request failed (${me.lastRequest.status ?? "no answer"})`}: {me.lastRequest.client}, {me.lastRequest.model}, {ago(me.lastRequest.ts)}
          </p>
        ) : (
          <p>
            <i className="cn-dot cn-dot--wait" aria-hidden />
            Waiting for your first request…
          </p>
        )}
      </section>

      <Usage />
      {me.personalKeys ? <PersonalKeys /> : null}
    </main>
  );
}

function Usage() {
  const [rows, setRows] = useState<UsageRow[] | null>(null);
  useEffect(() => {
    call<{ byModel: UsageRow[] }>("/me/usage")
      .then((r) => setRows(r.byModel))
      .catch(() => setRows([]));
  }, []);
  return (
    <section className="panel cn-card" aria-label="My usage">
      <h2 className="cn-h2">My usage, last 30 days</h2>
      {!rows ? null : rows.length === 0 ? (
        <p className="cn-muted">No requests yet.</p>
      ) : (
        <table className="cn-table">
          <thead>
            <tr>
              <th>Model</th>
              <th>Requests</th>
              <th>Tokens in / out</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.model}>
                <td className="mono">{r.model}</td>
                <td>{r.requests}</td>
                <td>
                  {count(r.inTok)} / {count(r.outTok)}
                </td>
                <td>{r.costUsd ? money(r.costUsd) : r.subscriptionRequests === r.requests ? "Subscription" : "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function PersonalKeys() {
  const [keys, setKeys] = useState<Key[]>([]);
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = () => call<{ keys: Key[] }>("/me/keys").then((r) => setKeys(r.keys), () => {});
  useEffect(() => void load(), []);
  const create = async () => {
    setError(null);
    try {
      const r = await call<{ key: string }>("/me/keys", { method: "POST", body: JSON.stringify({ name, expiry: "90" }) });
      setFresh(r.key);
      setSaved(false);
      setName("");
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <section className="panel cn-card" aria-label="My gateway keys">
      <h2 className="cn-h2">My gateway keys</h2>
      <p className="cn-muted">For your own tools off the tailnet. A key acts as you and expires in 90 days.</p>
      {fresh ? (
        <div className="cn-reveal" role="dialog" aria-label="Your new key">
          <CopyBlock title="Your new key. It won't be shown again." code={fresh} />
          <label className="cn-check">
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I've saved this key
          </label>
          <button type="button" className="btn btn--sm" disabled={!saved} onClick={() => setFresh(null)}>
            Done
          </button>
        </div>
      ) : (
        <form
          className="cn-row"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <input className="field-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="laptop" aria-label="Key name" />
          <button type="submit" className="btn btn--sm btn--primary" disabled={!name.trim()}>
            New key
          </button>
        </form>
      )}
      {error ? <p className="cn-bad">{error}</p> : null}
      {keys.length ? (
        <ul className="cn-keys">
          {keys.map((k) => (
            <li key={k.id}>
              <span>
                <b>{k.name}</b> <code className="mono">{k.prefix}…</code>
                <span className="cn-muted"> · {k.lastUsedAt ? `used ${ago(k.lastUsedAt)}` : "never used"}{k.expiresAt ? ` · expires ${new Date(k.expiresAt).toLocaleDateString()}` : ""}</span>
              </span>
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => void call(`/me/keys/${k.id}`, { method: "DELETE" }).then(load)}>
                Revoke
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
