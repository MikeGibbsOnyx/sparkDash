// Onyx: People page: everyone who has opened sparkDash, their role and their groups.
import { useCallback, useEffect, useMemo, useState } from "react";
import { relativeTime } from "./relativeTime";
import { useAccess, useRole } from "./AccessContext";
import {
  ROLE_LABELS,
  atLeast,
  deleteGroup,
  fetchPeople,
  removePerson,
  saveGroup,
  setPersonRole,
  type Group,
  type Person,
  type Role,
} from "./accessApi";

const ROLE_ORDER: Role[] = ["member", "auditor", "admin", "owner"];

/** Roles the viewer may pick for this person. Empty means read-only for them. */
export function assignableRoles(viewer: Role | null, current: Role): Role[] {
  if (!atLeast(viewer, "admin")) return [];
  if (viewer === "owner") return ROLE_ORDER;
  // Admins manage everyone but Owners, and can't make Owners.
  return current === "owner" ? [] : ROLE_ORDER.filter((r) => r !== "owner");
}

export function PeoplePage() {
  const role = useRole();
  const { me, reload: reloadMe } = useAccess();
  const [people, setPeople] = useState<Person[] | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<Group | "new" | null>(null);
  const canEdit = atLeast(role, "admin");
  const myLogin = me?.signedIn ? me.login : null;

  const load = useCallback(() => {
    fetchPeople()
      .then((r) => {
        setPeople(r.people);
        setGroups(r.groups);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);
  useEffect(load, [load]);

  const changeRole = async (p: Person, next: Role) => {
    setNotice(null);
    try {
      await setPersonRole(p.login, next);
      setNotice(`${p.displayName || p.login} is now ${ROLE_LABELS[next] === "Admin" || ROLE_LABELS[next] === "Auditor" || ROLE_LABELS[next] === "Owner" ? "an" : "a"} ${ROLE_LABELS[next]}.`);
      if (p.login === myLogin) reloadMe();
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async (p: Person) => {
    if (!window.confirm(`Remove ${p.displayName || p.login} from People? If they open sparkDash again they'll get the default role.`)) return;
    try {
      await removePerson(p.login);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="pp">
      <header className="page-head">
        <div>
          <h1>People</h1>
          <p className="page-head__sub">
            Everyone who has opened sparkDash through Tailscale. Tailscale says who they are; their role here decides what they can do.
            {canEdit ? "" : " You can view this page but not change it."}
          </p>
        </div>
        {canEdit ? (
          <div className="page-head__tools">
            <button type="button" className="btn btn--sm" onClick={() => setEditing("new")}>
              New group
            </button>
          </div>
        ) : null}
      </header>

      {error ? (
        <div className="pp-banner pp-bad" role="alert">
          {error}
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      ) : null}
      {notice ? (
        <div className="pp-banner pp-ok" role="status">
          {notice}
        </div>
      ) : null}

      <section className="panel pp-panel" aria-label="People">
        {people === null ? (
          <p className="pp-empty">Loading…</p>
        ) : people.length === 0 ? (
          <p className="pp-empty">No one has opened sparkDash through Tailscale yet. Share this dashboard's Tailscale Serve address with your team.</p>
        ) : (
          <div className="pp-scroll">
            <table className="pp-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Role</th>
                  <th>Groups</th>
                  <th>Last seen</th>
                  <th>Last device</th>
                  {canEdit ? <th aria-label="Actions" /> : null}
                </tr>
              </thead>
              <tbody>
                {people.map((p) => {
                  const options = assignableRoles(role, p.role);
                  return (
                    <tr key={p.login}>
                      <td>
                        <div className="pp-name">{p.displayName || p.login}</div>
                        <div className="pp-login mono">{p.login}</div>
                      </td>
                      <td>
                        {options.length ? (
                          <select
                            className="field-input pp-role"
                            aria-label={`Role for ${p.displayName || p.login}`}
                            value={p.role}
                            onChange={(e) => void changeRole(p, e.target.value as Role)}
                          >
                            {options.map((r) => (
                              <option key={r} value={r}>
                                {ROLE_LABELS[r]}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className={`pp-chip pp-chip--${p.role}`}>{ROLE_LABELS[p.role]}</span>
                        )}
                      </td>
                      <td>{p.groups.length ? p.groups.join(", ") : <span className="pp-muted">None</span>}</td>
                      <td title={new Date(p.lastSeen).toLocaleString()}>{relativeTime(p.lastSeen)}</td>
                      <td>{p.lastDevice || <span className="pp-muted">Unknown</span>}</td>
                      {canEdit ? (
                        <td className="pp-actions">
                          {options.length && p.login !== myLogin ? (
                            <button type="button" className="btn btn--sm btn--ghost" onClick={() => void remove(p)}>
                              Remove
                            </button>
                          ) : null}
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel pp-panel" aria-label="Groups">
        <h2 className="pp-h2">Groups</h2>
        {groups.length === 0 ? (
          <p className="pp-empty">{canEdit ? "No groups yet. Create one to give a team the same access in one step." : "No groups yet."}</p>
        ) : (
          <ul className="pp-groups">
            {groups.map((g) => (
              <li key={g.id}>
                <div>
                  <b>{g.name}</b>
                  <span className="pp-muted"> · {g.members.length} member{g.members.length === 1 ? "" : "s"}</span>
                  <div className="pp-login mono">{g.members.join(", ") || "Empty"}</div>
                </div>
                {canEdit ? (
                  <button type="button" className="btn btn--sm btn--ghost" onClick={() => setEditing(g)}>
                    Edit
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {editing ? (
        <GroupPanel
          group={editing === "new" ? null : editing}
          people={people ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      ) : null}
    </div>
  );
}

function GroupPanel({ group, people, onClose, onSaved }: { group: Group | null; people: Person[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(group?.name ?? "");
  const [members, setMembers] = useState<string[]>(group?.members ?? []);
  const [extra, setExtra] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const others = useMemo(() => members.filter((m) => !people.some((p) => p.login.toLowerCase() === m.toLowerCase())), [members, people]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const toggle = (login: string) => setMembers((m) => (m.includes(login) ? m.filter((x) => x !== login) : [...m, login]));
  const addExtra = () => {
    const v = extra.trim();
    if (v && !members.includes(v)) setMembers([...members, v]);
    setExtra("");
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await saveGroup({ id: group?.id, name, members });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const del = async () => {
    if (!group || !window.confirm(`Delete group ${group.name}? Its members keep their roles.`)) return;
    try {
      await deleteGroup(group.id);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="pp-side-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="pp-side panel" role="dialog" aria-modal="true" aria-label={group ? `Edit group ${group.name}` : "New group"}>
        <h2 className="pp-h2">{group ? `Edit ${group.name}` : "New group"}</h2>
        <label className="pp-field">
          <span>Name</span>
          <input className="field-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Engineering" autoFocus />
        </label>
        <fieldset className="pp-field">
          <legend>People</legend>
          {people.length === 0 ? <p className="pp-muted">No one has opened sparkDash yet.</p> : null}
          {people.map((p) => (
            <label key={p.login} className="pp-check">
              <input type="checkbox" checked={members.includes(p.login)} onChange={() => toggle(p.login)} />
              <span>{p.displayName || p.login}</span>
              <span className="pp-login mono">{p.login}</span>
            </label>
          ))}
        </fieldset>
        <div className="pp-field">
          <span>Also include (a login, tag:name or key:name)</span>
          <div className="pp-claim__row">
            <input
              className="field-input mono"
              value={extra}
              onChange={(e) => setExtra(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addExtra();
                }
              }}
              placeholder="tag:ci"
            />
            <button type="button" className="btn btn--sm" onClick={addExtra} disabled={!extra.trim()}>
              Add
            </button>
          </div>
          {others.length ? (
            <ul className="pp-tags">
              {others.map((m) => (
                <li key={m}>
                  <span className="mono">{m}</span>
                  <button type="button" className="btn btn--sm btn--ghost" aria-label={`Remove ${m}`} onClick={() => toggle(m)}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        {error ? (
          <p className="pp-bad" role="alert">
            {error}
          </p>
        ) : null}
        <div className="pp-side__foot">
          {group ? (
            <button type="button" className="btn btn--sm btn--ghost pp-danger" onClick={() => void del()}>
              Delete group
            </button>
          ) : (
            <span />
          )}
          <div className="pp-claim__row">
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="btn btn--primary" onClick={() => void save()} disabled={busy || !name.trim()}>
              Save
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}
