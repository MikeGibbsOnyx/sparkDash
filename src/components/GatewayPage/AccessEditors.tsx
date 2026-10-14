// Onyx: Access tab editors: grants (with a preview of who gains or loses access) and budgets.
import { useEffect, useMemo, useState } from "react";
import { relativeTime } from "../PeoplePage/relativeTime";
import type { Group, Person } from "../PeoplePage/accessApi";
import {
  createBudget,
  createGrant,
  previewGrant,
  removeBudget,
  removeGrant,
  tokens,
  updateBudget,
  updateGrant,
  usd,
  type Budget,
  type BudgetDraft,
  type GatewayKey,
  type Grant,
  type GrantDraft,
  type GrantPreview,
  type Period,
} from "./gatewayApi";

const split = (s: string) =>
  s
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

function Preview({ p }: { p: GrantPreview | null }) {
  if (!p) return <p className="gw-muted gw-small">Checking who this affects…</p>;
  if (!p.changes.length) return <p className="gw-muted gw-small">Nobody gains or loses access.</p>;
  return (
    <ul className="gw-preview" aria-label="Who gains or loses access">
      {p.changes.map((c) => (
        <li key={c.caller}>
          <b>{c.caller}</b>
          {c.gains.length ? <span className="gw-ok"> gains {c.gains.join(", ")}</span> : null}
          {c.gains.length && c.losses.length ? ";" : null}
          {c.losses.length ? <span className="gw-bad"> loses {c.losses.join(", ")}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function GrantForm({ grant, people, groups, onDone, onCancel }: { grant: Grant | null; people: Person[]; groups: Group[]; onDone: () => void; onCancel: () => void }) {
  const [name, setName] = useState(grant?.name ?? "");
  const [who, setWho] = useState(grant?.selectors.join(", ") ?? "");
  const [models, setModels] = useState(grant?.modelPatterns.join(", ") ?? "");
  const [tools, setTools] = useState(grant?.mcpPatterns.join(", ") ?? "");
  const [preview, setPreview] = useState<GrantPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const draft: GrantDraft = useMemo(() => ({ name: name || "draft", selectors: split(who), modelPatterns: split(models), mcpPatterns: split(tools) }), [name, who, models, tools]);

  useEffect(() => {
    if (!draft.selectors.length || (!draft.modelPatterns.length && !draft.mcpPatterns?.length)) {
      setPreview({ changes: [] });
      return;
    }
    setPreview(null);
    const t = setTimeout(() => {
      previewGrant({ id: grant?.id ?? null, draft }).then(
        (p) => (setPreview(p), setError(null)),
        (e) => (setPreview({ changes: [] }), setError(e instanceof Error ? e.message : String(e)))
      );
    }, 300);
    return () => clearTimeout(t);
  }, [draft, grant]);

  const save = async () => {
    try {
      const body = { ...draft, name };
      if (grant) await updateGrant(grant.id, body);
      else await createGrant(body);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
      <h3 className="gw-h3">{grant ? `Edit grant ${grant.name}` : "New grant"}</h3>
      <label>
        <span>Name</span>
        <input className="field-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Engineering: Claude" autoFocus />
      </label>
      <label>
        <span>Who</span>
        <input className="field-input mono" list="gw-selectors" value={who} onChange={(e) => setWho(e.target.value)} placeholder="group:eng, sam@example.com" />
        <datalist id="gw-selectors">
          <option value="*">Everyone</option>
          {groups.map((g) => (
            <option key={g.id} value={`group:${g.name}`} />
          ))}
          {people.map((p) => (
            <option key={p.login} value={p.login} />
          ))}
        </datalist>
      </label>
      <p className="gw-muted gw-small">
        <span className="mono">*</span> everyone, a login, <span className="mono">group:</span>name, <span className="mono">tag:</span>name, <span className="mono">key:</span>name or <span className="mono">local</span>. Separate with commas.
      </p>
      <label>
        <span>Models</span>
        <input className="field-input mono" value={models} onChange={(e) => setModels(e.target.value)} placeholder="claude-*, spark-1/*" />
      </label>
      <label>
        <span>MCP tools</span>
        <input className="field-input mono" value={tools} onChange={(e) => setTools(e.target.value)} placeholder="github__*, linear__create_issue" />
      </label>
      <Preview p={preview} />
      {error ? <p className="gw-bad">{error}</p> : null}
      <div className="gw-row">
        <button type="submit" className="btn btn--primary btn--sm" disabled={!name.trim() || !draft.selectors.length || (!draft.modelPatterns.length && !draft.mcpPatterns?.length)}>
          {grant ? "Save grant" : "Create grant"}
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function RemoveGrant({ grant, onDone, onCancel }: { grant: Grant; onDone: () => void; onCancel: () => void }) {
  const [preview, setPreview] = useState<GrantPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    previewGrant({ id: grant.id, draft: null }).then(setPreview, (e) => setError(String(e?.message || e)));
  }, [grant]);
  return (
    <div className="gw-inline gw-confirm" role="alertdialog" aria-label={`Remove grant ${grant.name}`}>
      <p>Remove the grant {grant.name}?</p>
      <Preview p={preview} />
      {error ? <p className="gw-bad">{error}</p> : null}
      <div className="gw-row">
        <button type="button" className="btn btn--sm gw-danger" disabled={!preview} onClick={() => void removeGrant(grant.id).then(onDone, (e) => setError(String(e?.message || e)))}>
          Remove grant
        </button>
        <button type="button" className="btn btn--sm btn--ghost" onClick={onCancel}>
          Keep it
        </button>
      </div>
    </div>
  );
}

export function GrantsSection({ grants, people, groups, canEdit, onChanged }: { grants: Grant[]; people: Person[]; groups: Group[]; canEdit: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState<Grant | "new" | null>(null);
  const [removing, setRemoving] = useState<Grant | null>(null);
  const done = () => {
    setEditing(null);
    setRemoving(null);
    onChanged();
  };
  return (
    <section className="panel gw-section" aria-label="Grants">
      <div className="gw-section__head">
        <h2 className="gw-h2">Grants</h2>
        {canEdit && !editing ? (
          <button type="button" className="btn btn--sm" onClick={() => setEditing("new")}>
            New grant
          </button>
        ) : null}
      </div>
      <p className="gw-muted gw-small">Who may use which models. Access is the union of every grant that matches a person, so narrowing Everyone takes access away unless another grant gives it back.</p>
      {editing ? <GrantForm grant={editing === "new" ? null : editing} people={people} groups={groups} onDone={done} onCancel={() => setEditing(null)} /> : null}
      <ul className="gw-list">
        {grants.map((g) => (
          <li key={g.id}>
            <div>
              <b>{g.name}</b>
              <div className="gw-small">
                <span className="mono">{g.selectors.join(", ")}</span> → <span className="mono">{g.modelPatterns.join(", ") || "no models"}</span>
                {g.mcpPatterns.length ? (
                  <>
                    {" "}
                    · tools <span className="mono">{g.mcpPatterns.join(", ")}</span>
                  </>
                ) : null}
              </div>
              <div className="gw-small gw-muted">{g.updatedBy ? `Changed ${relativeTime(g.updatedAt)} by ${g.updatedBy}` : null}</div>
              {removing?.id === g.id ? <RemoveGrant grant={g} onDone={done} onCancel={() => setRemoving(null)} /> : null}
            </div>
            {canEdit && removing?.id !== g.id ? (
              <div className="gw-row">
                <button type="button" className="btn btn--sm btn--ghost" onClick={() => (setRemoving(null), setEditing(g))}>
                  Edit
                </button>
                <button type="button" className="btn btn--sm btn--ghost" onClick={() => (setEditing(null), setRemoving(g))}>
                  Remove
                </button>
              </div>
            ) : null}
          </li>
        ))}
        {grants.length === 0 ? <li className="gw-muted">No grants: nobody can use any model. Create one, such as Everyone → *.</li> : null}
      </ul>
    </section>
  );
}

// ─── Budgets ──────────────────────────────────────────────
const PERIOD_LABEL: Record<Period, string> = { day: "a day", week: "a week", month: "a month" };

export function scopeLabel(scope: string) {
  if (scope === "everyone") return "Everyone";
  const [kind, ...rest] = scope.split(":");
  const v = rest.join(":");
  return kind === "group" ? `Group ${v}` : kind === "key" ? `Gateway key ${v}` : v;
}

function BudgetBar({ b }: { b: Budget }) {
  const frac = b.limitUsd != null ? (b.limitUsd > 0 ? b.spentUsd / b.limitUsd : 1) : b.limitTokens ? b.spentTokens / b.limitTokens : 1;
  const pct = Math.min(100, Math.round(frac * 100));
  return (
    <div className={`gw-bar gw-bar--${b.state}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`${b.name} used`}>
      <div style={{ width: `${pct}%` }} />
    </div>
  );
}

export function budgetUsedText(b: Budget) {
  const parts = [];
  if (b.limitUsd != null) parts.push(`${usd(b.spentUsd)} of ${usd(b.limitUsd)}`);
  if (b.limitTokens != null) parts.push(`${tokens(b.spentTokens)} of ${tokens(b.limitTokens)} tokens`);
  return parts.join(" · ");
}

function BudgetForm({ budget, people, groups, keys, timeZone, onDone, onCancel }: { budget: Budget | null; people: Person[]; groups: Group[]; keys: GatewayKey[]; timeZone: string; onDone: () => void; onCancel: () => void }) {
  const initialKind = budget ? (budget.scope === "everyone" ? "everyone" : budget.scope.split(":")[0]) : "person";
  const [name, setName] = useState(budget?.name ?? "");
  const [kind, setKind] = useState(initialKind);
  const [target, setTarget] = useState(budget && budget.scope !== "everyone" ? budget.scope.slice(budget.scope.indexOf(":") + 1) : "");
  const [period, setPeriod] = useState<Period>(budget?.period ?? "month");
  const [limitUsd, setLimitUsd] = useState(budget?.limitUsd?.toString() ?? "");
  const [limitTokens, setLimitTokens] = useState(budget?.limitTokens?.toString() ?? "");
  const [warnPct, setWarnPct] = useState(String(budget?.warnPct ?? 80));
  const [error, setError] = useState<string | null>(null);
  const options = kind === "person" ? people.map((p) => p.login) : kind === "group" ? groups.map((g) => g.name) : kind === "key" ? keys.filter((k) => !k.actsAs && k.state !== "revoked").map((k) => k.name) : [];

  const save = async () => {
    const draft: BudgetDraft = {
      name,
      scope: kind === "everyone" ? "everyone" : `${kind}:${target}`,
      period,
      limitUsd: limitUsd.trim() === "" ? null : Number(limitUsd),
      limitTokens: limitTokens.trim() === "" ? null : Number(limitTokens.replace(/[,_\s]/g, "")),
      warnPct: Number(warnPct),
    };
    try {
      if (budget) await updateBudget(budget.id, draft);
      else await createBudget(draft);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
      <h3 className="gw-h3">{budget ? `Edit budget ${budget.name}` : "New budget"}</h3>
      <label>
        <span>Name</span>
        <input className="field-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Sam monthly" autoFocus />
      </label>
      <label>
        <span>Covers</span>
        <select className="field-input" value={kind} onChange={(e) => (setKind(e.target.value), setTarget(""))}>
          <option value="everyone">Everyone together</option>
          <option value="person">A person</option>
          <option value="group">A group</option>
          <option value="key">A gateway key</option>
        </select>
      </label>
      {kind !== "everyone" ? (
        <label>
          <span>{kind === "person" ? "Person" : kind === "group" ? "Group" : "Key"}</span>
          <input className="field-input mono" list="gw-budget-targets" value={target} onChange={(e) => setTarget(e.target.value)} placeholder={kind === "person" ? "sam@example.com" : kind === "group" ? "eng" : "ci-deploy"} />
          <datalist id="gw-budget-targets">
            {options.map((o) => (
              <option key={o} value={o} />
            ))}
          </datalist>
        </label>
      ) : null}
      <label>
        <span>Period</span>
        <select className="field-input" value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
          <option value="day">Day</option>
          <option value="week">Week (from Monday)</option>
          <option value="month">Month</option>
        </select>
      </label>
      <label>
        <span>Limit in USD</span>
        <input className="field-input mono" inputMode="decimal" value={limitUsd} onChange={(e) => setLimitUsd(e.target.value)} placeholder="50" />
      </label>
      <label>
        <span>Limit in tokens</span>
        <input className="field-input mono" inputMode="numeric" value={limitTokens} onChange={(e) => setLimitTokens(e.target.value)} placeholder="Optional" />
      </label>
      <label>
        <span>Warn at</span>
        <input className="field-input mono gw-narrow" inputMode="numeric" value={warnPct} onChange={(e) => setWarnPct(e.target.value)} aria-label="Warn at percent" />%
      </label>
      <p className="gw-muted gw-small">
        Periods follow {timeZone} (Settings → Time zone). Own-subscription use counts toward token limits only. Tokens include cached input. A request that could cost more than is left is refused up front, from its maximum output at the model's output price.
      </p>
      {error ? <p className="gw-bad">{error}</p> : null}
      <div className="gw-row">
        <button type="submit" className="btn btn--primary btn--sm" disabled={!name.trim() || (kind !== "everyone" && !target.trim()) || (!limitUsd.trim() && !limitTokens.trim())}>
          {budget ? "Save budget" : "Create budget"}
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function BudgetsSection({ budgets, timeZone, people, groups, keys, canEdit, onChanged }: { budgets: Budget[]; timeZone: string; people: Person[]; groups: Group[]; keys: GatewayKey[]; canEdit: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState<Budget | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const done = () => {
    setEditing(null);
    onChanged();
  };
  return (
    <section className="panel gw-section" aria-label="Budgets">
      <div className="gw-section__head">
        <h2 className="gw-h2">Budgets</h2>
        {canEdit && !editing ? (
          <button type="button" className="btn btn--sm" onClick={() => setEditing("new")}>
            New budget
          </button>
        ) : null}
      </div>
      {editing ? <BudgetForm budget={editing === "new" ? null : editing} people={people} groups={groups} keys={keys} timeZone={timeZone} onDone={done} onCancel={() => setEditing(null)} /> : null}
      {budgets.length === 0 && !editing ? <p className="gw-muted">No budgets. Requests are limited only by grants. Add one to cap spend for a person, group, gateway key or everyone.</p> : null}
      {error ? <p className="gw-bad">{error}</p> : null}
      <ul className="gw-list">
        {budgets.map((b) => (
          <li key={b.id} className="gw-budget">
            <div>
              <b>{b.name}</b>{" "}
              {b.state !== "ok" ? <span className={`gw-chip ${b.state === "exhausted" ? "gw-chip--bad" : "gw-chip--warn"}`}>{b.state === "exhausted" ? "Used up" : `Past ${b.warnPct}%`}</span> : null}
              <div className="gw-small gw-muted">
                {scopeLabel(b.scope)} · {[b.limitUsd != null ? usd(b.limitUsd) : null, b.limitTokens != null ? `${tokens(b.limitTokens)} tokens` : null].filter(Boolean).join(" and ")} {PERIOD_LABEL[b.period]} · resets {b.resets}
              </div>
              <BudgetBar b={b} />
              <div className="gw-small">
                {budgetUsedText(b)}
                {b.inFlightUsd > 0 ? <span className="gw-muted"> · {usd(b.inFlightUsd)} reserved by requests in progress</span> : null}
              </div>
            </div>
            {canEdit ? (
              <div className="gw-row">
                <button type="button" className="btn btn--sm btn--ghost" onClick={() => setEditing(b)}>
                  Edit
                </button>
                <button
                  type="button"
                  className="btn btn--sm btn--ghost"
                  onClick={() => {
                    if (window.confirm(`Remove the budget ${b.name}? Requests it covers are no longer limited by it.`)) void removeBudget(b.id).then(onChanged, (e) => setError(String(e?.message || e)));
                  }}
                >
                  Remove
                </button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
