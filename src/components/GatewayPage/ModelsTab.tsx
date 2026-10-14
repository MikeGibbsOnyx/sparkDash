// Onyx: Models tab: provider keys (paste, Test and save, write-only cards), local servers, models.
import { useCallback, useEffect, useMemo, useState } from "react";
import { relativeTime } from "../PeoplePage/relativeTime";
import {
  PROVIDER_LABELS,
  addProvider,
  detectProvider,
  fetchLocalServers,
  fetchModels,
  fetchProviders,
  providerImpact,
  removeProvider,
  replaceProviderKey,
  retestProvider,
  setModelEnabled,
  setModelPrices,
  setServe,
  updateProvider,
  type LocalServer,
  type Model,
  type Prices,
  type Provider,
  type SaveResult,
} from "./gatewayApi";

const STREAM_USAGE_HELP = "Adds stream_options.include_usage to streamed Chat Completions so tokens are counted; the extra usage chunk is removed before the client sees it. Turn off for a server that rejects the field.";

const PICKABLE: Provider["type"][] = ["anthropic", "openai", "gemini", "openrouter"];

function mask(key: string) {
  const k = key.trim();
  return k.length > 12 ? `${k.slice(0, k.startsWith("sk-ant-") ? 7 : 3)}…${k.slice(-4)}` : "…";
}

function Result({ r }: { r: SaveResult }) {
  return (
    <div className={`gw-result ${r.ok ? "gw-ok" : r.ok === false ? "gw-bad" : "gw-warn"}`} role="status">
      {r.ok ? "● " : ""}
      {r.message}
      {r.details ? (
        <details>
          <summary>Details</summary>
          <pre className="mono">{r.details}</pre>
        </details>
      ) : null}
    </div>
  );
}

/** Paste first: one field, the prefix picks the provider; tiles below for anything else. */
export function AddProviderKey({ onSaved, compact = false }: { onSaved: () => void; compact?: boolean }) {
  const [key, setKey] = useState("");
  const [picked, setPicked] = useState<Provider["type"] | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SaveResult | null>(null);
  const detected = detectProvider(key);
  const type = picked || detected;

  const save = async (opts: { saveAnyway?: boolean } = {}) => {
    setBusy(true);
    try {
      const r = await addProvider({ key, type, ...opts });
      setResult(r);
      if (r.saved) {
        setKey("");
        setPicked(null);
        onSaved();
      }
    } catch (e) {
      setResult({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`gw-add ${compact ? "" : "panel"}`}>
      <label htmlFor="gw-paste" className="gw-label">
        Paste a provider key
      </label>
      <input
        id="gw-paste"
        type="password"
        className="field-input mono gw-paste"
        value={key}
        autoComplete="off"
        spellCheck={false}
        placeholder="sk-ant-…, sk-…, AIza…, sk-or-…"
        onChange={(e) => {
          setKey(e.target.value);
          setResult(null);
        }}
      />
      {key.trim() ? (
        <p className="gw-detected">
          {type ? (
            <>
              {picked ? "Using" : "Detected"}: <b>{PROVIDER_LABELS[type]}</b> · <span className="mono">{mask(key)}</span>
            </>
          ) : (
            "Couldn't tell the provider from this key. Pick one below."
          )}
        </p>
      ) : null}
      <div className="gw-tiles" role="group" aria-label="Or pick a provider">
        {PICKABLE.map((t) => (
          <button key={t} type="button" className={`gw-tile ${type === t ? "is-on" : ""}`} aria-pressed={picked === t} onClick={() => setPicked(picked === t ? null : t)}>
            {PROVIDER_LABELS[t]}
          </button>
        ))}
      </div>
      {!compact ? <p className="gw-muted">Local models: switch them on under Local models below.</p> : null}
      <div className="gw-row">
        <button type="button" className="btn btn--primary btn--sm" disabled={busy || !key.trim() || !type} onClick={() => void save()}>
          {busy ? "Testing…" : "Test and save"}
        </button>
        {result && result.ok === false && !result.saved ? (
          <button type="button" className="btn btn--sm btn--ghost" disabled={busy} onClick={() => void save({ saveAnyway: true })}>
            Save anyway
          </button>
        ) : null}
      </div>
      {result ? <Result r={result} /> : null}
    </div>
  );
}

function statusTone(s: Provider["status"]) {
  return s === "Working" ? "gw-chip--ok" : s === "Failing" ? "gw-chip--bad" : "gw-chip--warn";
}

function ProviderCard({ p, canEdit, onChanged }: { p: Provider; canEdit: boolean; onChanged: () => void }) {
  const [mode, setMode] = useState<"idle" | "replace" | "remove">("idle");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SaveResult | null>(null);
  const [impact, setImpact] = useState<{ people: number; requests: number; modelsUsed: number; modelsServed: number } | null>(null);
  const env = p.keySource === "env";

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setResult({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="panel gw-card" aria-label={`${p.name} provider key`}>
      <header className="gw-card__head">
        <b>{p.name}</b>
        <span className={`gw-chip ${statusTone(p.status)}`}>{p.status}</span>
      </header>
      <div className="mono gw-key">
        {p.type === "anthropic" ? "sk-ant-" : p.type === "gemini" ? "AIza" : p.type === "openrouter" ? "sk-or-" : "sk-"}…{p.keyLast4}
      </div>
      <dl className="gw-facts">
        <div>{env ? "Set by environment variable" : `Added ${new Date(p.addedAt).toLocaleDateString()} by ${p.addedBy || "unknown"}`}</div>
        <div>{p.lastUsedAt ? `Last used ${relativeTime(p.lastUsedAt)}` : "Not used yet"}</div>
        <div>
          {p.modelsEnabled} of {p.modelCount} models on
        </div>
        {p.status === "Failing" && p.lastError ? (
          <div className="gw-bad">
            {p.lastError}
            {p.lastTestedAt ? ` (${relativeTime(p.lastTestedAt)})` : ""}
          </div>
        ) : null}
      </dl>
      {p.ownLoginCapable ? (
        <label className="gw-switch">
          <input type="checkbox" checked={p.ownLogin} disabled={!canEdit || busy} onChange={(e) => void run(async () => (await updateProvider(p.id, { ownLogin: e.target.checked }), onChanged()))} />
          Let people use their own {p.type === "anthropic" ? "Claude" : "ChatGPT"} subscription
        </label>
      ) : null}
      {p.type === "openai" || p.type === "openrouter" ? (
        <label className="gw-switch" title={STREAM_USAGE_HELP}>
          <input type="checkbox" checked={p.injectUsage} disabled={!canEdit || busy} onChange={(e) => void run(async () => (await updateProvider(p.id, { injectUsage: e.target.checked }), onChanged()))} />
          Count tokens on streamed Chat Completions
        </label>
      ) : null}
      {canEdit ? (
        mode === "replace" ? (
          <div className="gw-inline">
            <input type="password" className="field-input mono" autoFocus placeholder="Paste the new key" value={key} onChange={(e) => setKey(e.target.value)} aria-label="New key" />
            <div className="gw-row">
              <button
                type="button"
                className="btn btn--sm btn--primary"
                disabled={busy || !key.trim()}
                onClick={() =>
                  void run(async () => {
                    const r = await replaceProviderKey(p.id, key);
                    setResult(r);
                    if (r.replaced) {
                      setKey("");
                      setMode("idle");
                      onChanged();
                    }
                  })
                }
              >
                {busy ? "Testing…" : "Test and replace"}
              </button>
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => setMode("idle")}>
                Cancel
              </button>
            </div>
          </div>
        ) : mode === "remove" ? (
          <div className="gw-inline gw-confirm" role="alertdialog" aria-label={`Remove ${p.name}`}>
            {impact ? (
              <p>
                In the last 24 hours this key served {impact.people} {impact.people === 1 ? "person" : "people"}, {impact.requests} request{impact.requests === 1 ? "" : "s"} and {impact.modelsUsed} model{impact.modelsUsed === 1 ? "" : "s"}. Removing it turns off {impact.modelsServed} model{impact.modelsServed === 1 ? "" : "s"} now.
              </p>
            ) : (
              <p>Checking what this key is used for…</p>
            )}
            <div className="gw-row">
              <button type="button" className="btn btn--sm gw-danger" disabled={busy || !impact} onClick={() => void run(async () => (await removeProvider(p.id), onChanged()))}>
                Remove key
              </button>
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => setMode("idle")}>
                Keep it
              </button>
            </div>
          </div>
        ) : (
          <div className="gw-row">
            <button type="button" className="btn btn--sm" disabled={env} title={env ? "Change the environment variable and restart the Gateway" : undefined} onClick={() => (setMode("replace"), setResult(null))}>
              Replace key
            </button>
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              disabled={env}
              onClick={() => {
                setMode("remove");
                setImpact(null);
                void providerImpact(p.id).then(setImpact, (e) => setResult({ ok: false, message: String(e?.message || e) }));
              }}
            >
              Remove
            </button>
            <button type="button" className="btn btn--sm btn--ghost" disabled={busy} onClick={() => void run(async () => (setResult(await retestProvider(p.id)), onChanged()))}>
              {busy ? "Testing…" : "Test"}
            </button>
          </div>
        )
      ) : null}
      {result ? <Result r={result} /> : null}
      <p className="gw-muted gw-small">Full key never shown again.</p>
    </article>
  );
}

function LocalServers({ servers, canEdit, onChanged }: { servers: LocalServer[]; canEdit: boolean; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="panel gw-section" aria-label="Local models">
      <h2 className="gw-h2">Local models</h2>
      {servers.length === 0 ? (
        <p className="gw-muted">No local model servers detected. Add a Spark or GPU host with an LLM port on the Overview page and it appears here.</p>
      ) : (
        <ul className="gw-list">
          {servers.map((s) => (
            <li key={s.id}>
              <div>
                <b>
                  {s.machine} :{s.port}
                </b>{" "}
                <span className="gw-muted">
                  {s.backend || "server"} · {s.up ? "up" : "down"}
                  {s.hasApiKey ? " · uses its saved API key" : ""}
                </span>
                <div className="mono gw-small">{s.models.join(", ") || "No models reported"}</div>
                {s.fix ? <div className="gw-warn gw-small">{s.fix}</div> : null}
              </div>
              <label className="gw-switch">
                <input
                  type="checkbox"
                  checked={s.serve}
                  disabled={!canEdit || !s.reachable}
                  onChange={(e) => void setServe(s.id, e.target.checked).then(onChanged, (err) => setError(String(err?.message || err)))}
                />
                Serve through the gateway
              </label>
              {s.serve ? (
                <label className="gw-switch gw-small" title={STREAM_USAGE_HELP}>
                  <input
                    type="checkbox"
                    checked={s.injectUsage}
                    disabled={!canEdit}
                    onChange={(e) => void updateProvider(`local-${s.id}`, { injectUsage: e.target.checked }).then(onChanged, (err) => setError(String(err?.message || err)))}
                  />
                  Count tokens on streams
                </label>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {error ? <p className="gw-bad">{error}</p> : null}
    </section>
  );
}

const PRICE_FIELDS: { k: keyof Prices; label: string }[] = [
  { k: "in", label: "Input" },
  { k: "out", label: "Output" },
  { k: "cacheRead", label: "Cache read" },
  { k: "cacheWrite", label: "Cache write" },
];

function fmtPrice(v: number | null) {
  return v == null ? "-" : `$${v}`;
}

/** Shows a model's prices, or "No price set" with an inline field. */
function PriceCell({ m, canEdit, onChanged }: { m: Model; canEdit: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<keyof Prices, string>>({ in: "", out: "", cacheRead: "", cacheWrite: "" });
  const [error, setError] = useState<string | null>(null);
  if (!m.needsPrice) return <span className="gw-muted gw-small">Energy cost</span>;
  const priced = m.prices.in != null || m.prices.out != null;
  const open = () => {
    setDraft({ in: m.prices.in?.toString() ?? "", out: m.prices.out?.toString() ?? "", cacheRead: m.prices.cacheRead?.toString() ?? "", cacheWrite: m.prices.cacheWrite?.toString() ?? "" });
    setError(null);
    setEditing(true);
  };
  if (editing) {
    const save = async () => {
      const body: Partial<Prices> = {};
      for (const { k } of PRICE_FIELDS) body[k] = draft[k].trim() === "" ? null : Number(draft[k]);
      try {
        await setModelPrices(m.id, body);
        setEditing(false);
        onChanged();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    };
    return (
      <form
        className="gw-prices"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {PRICE_FIELDS.map(({ k, label }) => (
          <label key={k}>
            <span className="gw-small">{label}</span>
            <input className="field-input mono" inputMode="decimal" value={draft[k]} placeholder={k.startsWith("cache") ? "= input" : "$"} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} aria-label={`${m.name} ${label} price`} />
          </label>
        ))}
        <div className="gw-row">
          <button type="submit" className="btn btn--sm btn--primary">
            Save
          </button>
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
        {error ? <p className="gw-bad gw-small">{error}</p> : null}
      </form>
    );
  }
  return (
    <span className="gw-pricecell">
      {priced ? (
        <span className="mono gw-small" title="Input / output / cache read / cache write">
          {fmtPrice(m.prices.in)} / {fmtPrice(m.prices.out)}
          {m.prices.cacheRead != null || m.prices.cacheWrite != null ? ` · cache ${fmtPrice(m.prices.cacheRead)} / ${fmtPrice(m.prices.cacheWrite)}` : ""}
        </span>
      ) : (
        <span className="gw-chip gw-chip--warn">No price set</span>
      )}
      {canEdit ? (
        <button type="button" className="btn btn--sm btn--ghost" onClick={open}>
          {priced ? "Edit" : "Set price"}
        </button>
      ) : null}
    </span>
  );
}

function ModelList({ models, conflicts, canEdit, onChanged }: { models: Model[]; conflicts: { name: string; providers: string }[]; canEdit: boolean; onChanged: () => void }) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => models.filter((m) => !q || m.name.toLowerCase().includes(q.toLowerCase()) || m.providerName.toLowerCase().includes(q.toLowerCase())), [models, q]);
  return (
    <section className="panel gw-section" aria-label="Models">
      <div className="gw-section__head">
        <h2 className="gw-h2">Models</h2>
        <input className="field-input" placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter models" />
      </div>
      {conflicts.length ? (
        <div className="gw-bad gw-small" role="alert">
          {conflicts.map((c) => (
            <div key={c.name}>
              <b>{c.name}</b> is offered by {c.providers}. Switch it off in all but one; requests for it fail until then.
            </div>
          ))}
        </div>
      ) : null}
      {models.length === 0 ? (
        <p className="gw-muted">Add a provider key or switch on a local server to list its models.</p>
      ) : (
        <div className="gw-scroll">
          <table className="gw-table">
            <thead>
              <tr>
                <th>Model</th>
                <th>Provider</th>
                <th title="US dollars per million tokens: input, output, cache read, cache write">Price per million tokens</th>
                <th>On</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((m) => (
                <tr key={m.id}>
                  <td className="mono">{m.name}</td>
                  <td>{m.providerName}</td>
                  <td>
                    <PriceCell m={m} canEdit={canEdit} onChanged={onChanged} />
                  </td>
                  <td>
                    <input type="checkbox" aria-label={`${m.name} on`} checked={m.enabled} disabled={!canEdit} onChange={(e) => void setModelEnabled(m.id, e.target.checked).then(onChanged)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="gw-muted gw-small">
        Prices are US dollars per million tokens, as the provider bills them. sparkDash has no built-in price list. A request keeps the price it was charged at. Local models are costed from measured energy; own-subscription use shows as Subscription.
      </p>
    </section>
  );
}

export function ModelsTab({ canEdit, onChanged }: { canEdit: boolean; onChanged: () => void }) {
  const [providers, setProviders] = useState<Provider[] | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [conflicts, setConflicts] = useState<{ name: string; providers: string }[]>([]);
  const [servers, setServers] = useState<LocalServer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    Promise.all([fetchProviders(), fetchModels(), fetchLocalServers()])
      .then(([p, m, s]) => {
        setProviders(p.providers);
        setModels(m.models);
        setConflicts(m.conflicts);
        setServers(s.servers);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(load, [load]);
  const changed = () => {
    load();
    onChanged();
  };
  return (
    <div className="gw-tab">
      {error ? <p className="gw-bad">{error}</p> : null}
      {canEdit ? <AddProviderKey onSaved={changed} /> : null}
      <div className="gw-cards">
        {(providers ?? []).map((p) => (
          <ProviderCard key={p.id} p={p} canEdit={canEdit} onChanged={changed} />
        ))}
        {providers && providers.length === 0 && !canEdit ? <p className="gw-muted">No provider keys yet.</p> : null}
      </div>
      <LocalServers servers={servers} canEdit={canEdit} onChanged={changed} />
      <ModelList models={models} conflicts={conflicts} canEdit={canEdit} onChanged={load} />
    </div>
  );
}
