// Onyx: Access tab: grants, budgets and gateway keys.
import { useCallback, useEffect, useState } from "react";
import { relativeTime } from "../PeoplePage/relativeTime";
import { fetchPeople, type Group, type Person } from "../PeoplePage/accessApi";
import { BudgetsSection, GrantsSection } from "./AccessEditors";
import { snippetFor, curlCheck } from "../../connect/snippets";
import { createKey, fetchBudgets, fetchGatewaySettings, fetchGrants, fetchKeys, revokeKey, saveGatewaySettings, type Budget, type GatewayKey, type Grant } from "./gatewayApi";

function Copy({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="btn btn--sm" onClick={() => void navigator.clipboard?.writeText(text).then(() => (setDone(true), setTimeout(() => setDone(false), 1500)))}>
      {done ? "Copied" : label}
    </button>
  );
}

/** Shown once: the key and a ready-to-paste setup block with it filled in. Closes only when ticked. */
export function RevealKeyDialog({ keyValue, name, url, onClose }: { keyValue: string; name: string; url: string; onClose: () => void }) {
  const [saved, setSaved] = useState(false);
  const setup = [
    `ANTHROPIC_BASE_URL=${url}`,
    `ANTHROPIC_API_KEY=${keyValue}`,
    `OPENAI_BASE_URL=${url}/v1`,
    `OPENAI_API_KEY=${keyValue}`,
  ].join("\n");
  const ci = snippetFor({ url, tool: "ci", os: "unix", credential: "company", key: keyValue, models: [] })[0];
  return (
    <div className="gw-overlay" role="presentation">
      <div className="panel gw-dialog" role="dialog" aria-modal="true" aria-label={`Gateway key ${name}`}>
        <h2 className="gw-h2">Gateway key {name}</h2>
        <p className="gw-warn">This is the only time the key is shown. Copy it somewhere safe now.</p>
        <div className="gw-copyrow">
          <code className="mono gw-secret">{keyValue}</code>
          <Copy text={keyValue} />
        </div>
        <div className="gw-copyrow gw-copyrow--block">
          <pre className="mono gw-pre">{setup}</pre>
          <Copy text={setup} label="Copy setup" />
        </div>
        <p className="gw-muted gw-small">
          For GitHub Actions, store the key as the <code>SPARKDASH_GATEWAY_KEY</code> secret:
        </p>
        <div className="gw-copyrow gw-copyrow--block">
          <pre className="mono gw-pre">{ci.code}</pre>
          <Copy text={ci.code} label="Copy" />
        </div>
        <div className="gw-copyrow gw-copyrow--block">
          <pre className="mono gw-pre">{curlCheck(url, keyValue)}</pre>
          <Copy text={curlCheck(url, keyValue)} label="Copy check" />
        </div>
        <label className="gw-switch">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I've saved this key
        </label>
        <div className="gw-row gw-row--end">
          <button type="button" className="btn btn--primary btn--sm" disabled={!saved} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function NewKeyForm({ grants, onCreated, onCancel }: { grants: Grant[]; onCreated: (key: string, name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [access, setAccess] = useState("");
  const [expiry, setExpiry] = useState("90");
  const [groups, setGroups] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetchPeople().then((r) => setGroups(r.groups.map((g) => g.name)), () => {});
  }, []);
  const create = async () => {
    setError(null);
    try {
      const r = await createKey({ name, access: access || null, expiry });
      onCreated(r.key, r.record.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <form
      className="panel gw-form"
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
      <h3 className="gw-h3">New gateway key</h3>
      <label>
        <span>Name</span>
        <input className="field-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="ci-deploy" autoFocus />
      </label>
      <label>
        <span>What it may use</span>
        <select className="field-input" value={access} onChange={(e) => setAccess(e.target.value)}>
          <option value="">Grants that name this key (key:{name || "name"}) or everyone</option>
          {groups.map((g) => (
            <option key={g} value={`group:${g}`}>
              The {g} group's access
            </option>
          ))}
          {grants.map((g) => (
            <option key={g.id} value={`grant:${g.id}`}>
              Only the grant “{g.name}”
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Expires</span>
        <select className="field-input" value={expiry} onChange={(e) => setExpiry(e.target.value)}>
          <option value="30">In 30 days</option>
          <option value="90">In 90 days</option>
          <option value="365">In 1 year</option>
          <option value="never">Never</option>
        </select>
      </label>
      {error ? <p className="gw-bad">{error}</p> : null}
      <div className="gw-row">
        <button type="submit" className="btn btn--primary btn--sm" disabled={!name.trim()}>
          Create key
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function AccessTab({ canEdit, url, startNewKey = false }: { canEdit: boolean; url: string; startNewKey?: boolean }) {
  const [grants, setGrants] = useState<Grant[]>([]);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [timeZone, setTimeZone] = useState("UTC");
  const [people, setPeople] = useState<Person[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [keys, setKeys] = useState<GatewayKey[] | null>(null);
  const [personalKeys, setPersonalKeys] = useState<boolean | null>(null);
  const [creating, setCreating] = useState(startNewKey && canEdit);
  const [revealed, setRevealed] = useState<{ key: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    Promise.all([fetchGrants(), fetchKeys(), fetchGatewaySettings(), fetchBudgets()])
      .then(([g, k, s, b]) => {
        setGrants(g.grants);
        setKeys(k.keys);
        setPersonalKeys(s.personalKeys);
        setBudgets(b.budgets);
        setTimeZone(b.timeZone);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    fetchPeople().then(
      (r) => (setPeople(r.people), setGroups(r.groups)),
      () => {}
    );
  }, []);
  useEffect(load, [load]);

  return (
    <div className="gw-tab">
      {error ? <p className="gw-bad">{error}</p> : null}
      <GrantsSection grants={grants} people={people} groups={groups} canEdit={canEdit} onChanged={load} />
      <BudgetsSection budgets={budgets} timeZone={timeZone} people={people} groups={groups} keys={keys ?? []} canEdit={canEdit} onChanged={load} />

      <section className="panel gw-section" aria-label="Gateway keys">
        <div className="gw-section__head">
          <h2 className="gw-h2">Gateway keys</h2>
          {canEdit && !creating ? (
            <button type="button" className="btn btn--sm" onClick={() => setCreating(true)}>
              New gateway key
            </button>
          ) : null}
        </div>
        <p className="gw-muted gw-small">For callers Tailscale can't identify, such as CI runners and tagged servers. People on the tailnet don't need one.</p>
        {creating ? <NewKeyForm grants={grants} onCancel={() => setCreating(false)} onCreated={(key, name) => (setCreating(false), setRevealed({ key, name }), load())} /> : null}
        {keys && keys.length === 0 ? <p className="gw-muted">No gateway keys yet.</p> : null}
        {keys && keys.length ? (
          <div className="gw-scroll">
            <table className="gw-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Prefix</th>
                  <th>Created</th>
                  <th>Expires</th>
                  <th>Last used</th>
                  {canEdit ? <th aria-label="Actions" /> : null}
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id} className={k.state === "revoked" || k.state === "expired" ? "gw-dim" : ""}>
                    <td>
                      <b>{k.name}</b>
                      {k.actsAs ? <div className="gw-small gw-muted">personal key for {k.actsAs}</div> : k.access ? <div className="gw-small gw-muted">{k.access}</div> : null}
                    </td>
                    <td className="mono">{k.prefix}…</td>
                    <td>
                      {new Date(k.createdAt).toLocaleDateString()} by {k.createdBy}
                    </td>
                    <td>
                      {k.state === "expiring" ? <span className="gw-chip gw-chip--warn">Expires in {Math.max(1, Math.ceil((k.expiresAt! - Date.now()) / 86_400_000))} days</span> : null}
                      {k.state === "revoked" ? "Revoked" : k.state === "expired" ? "Expired" : k.expiresAt ? (k.state === "expiring" ? null : new Date(k.expiresAt).toLocaleDateString()) : "Never"}
                    </td>
                    <td>{k.lastUsedAt ? `${relativeTime(k.lastUsedAt)}${k.lastUsedFrom ? ` from ${k.lastUsedFrom}` : ""}` : "Never"}</td>
                    {canEdit ? (
                      <td>
                        {k.state !== "revoked" ? (
                          <button
                            type="button"
                            className="btn btn--sm btn--ghost"
                            onClick={() => {
                              if (window.confirm(`Revoke ${k.name}? It stops working on its next request.`)) void revokeKey(k.id).then(load);
                            }}
                          >
                            Revoke
                          </button>
                        ) : null}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {personalKeys !== null ? (
          <label className="gw-switch">
            <input type="checkbox" checked={personalKeys} disabled={!canEdit} onChange={(e) => void saveGatewaySettings({ personalKeys: e.target.checked }).then((s) => setPersonalKeys(s.personalKeys))} />
            People can create personal keys on the Connect page (they act as that person)
          </label>
        ) : null}
      </section>
      {revealed ? <RevealKeyDialog keyValue={revealed.key} name={revealed.name} url={url} onClose={() => setRevealed(null)} /> : null}
    </div>
  );
}
