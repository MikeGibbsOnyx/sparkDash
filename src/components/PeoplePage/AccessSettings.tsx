// Onyx: Settings additions: default role for new people, and Owner claim codes.
import { useEffect, useState } from "react";
import { useRole } from "./AccessContext";
import { ROLE_LABELS, atLeast, createClaimCode, fetchAccessSettings, saveAccessSettings, type Role } from "./accessApi";

export function AccessSettings() {
  const role = useRole();
  const [defaultRole, setDefaultRole] = useState<Role | null>(null);
  const [claim, setClaim] = useState<{ code: string; expiresAt: number } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const canEdit = atLeast(role, "admin");

  useEffect(() => {
    if (!atLeast(role, "auditor")) return;
    fetchAccessSettings()
      .then((s) => setDefaultRole(s.defaultRole))
      .catch(() => setDefaultRole(null));
  }, [role]);

  if (!atLeast(role, "auditor")) return null;

  const change = async (next: Role) => {
    setMsg(null);
    try {
      const s = await saveAccessSettings({ defaultRole: next });
      setDefaultRole(s.defaultRole);
      setMsg({ ok: true, text: `New people start as ${ROLE_LABELS[s.defaultRole]}.` });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    }
  };

  const makeCode = async () => {
    setMsg(null);
    try {
      setClaim(await createClaimCode());
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <>
      <div className="set-row">
        <div className="set-row__text">
          <label htmlFor="settings-default-role">Default role for new people</label>
          <small>The role someone gets the first time they open sparkDash through Tailscale. Change anyone's role later on the People page.</small>
        </div>
        <div className="set-row__control">
          <select
            id="settings-default-role"
            className="field-input"
            value={defaultRole ?? "member"}
            disabled={!canEdit || defaultRole == null}
            onChange={(e) => void change(e.target.value as Role)}
          >
            {(["member", "auditor", "admin"] as const).map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </div>
      </div>
      {role === "owner" ? (
        <div className="set-row set-row--stack">
          <div className="set-row__text">
            <span className="set-row__title">Owner claim code</span>
            <small>A one-time code that makes whoever enters it through Tailscale an Owner. Valid 24 hours, single use. Share it privately.</small>
          </div>
          <div className="set-row__control">
            {claim ? (
              <div className="pp-code" role="status">
                <code className="mono">{claim.code}</code>
                <button type="button" className="btn btn--sm" onClick={() => void navigator.clipboard?.writeText(claim.code)}>
                  Copy
                </button>
                <small>Expires {new Date(claim.expiresAt).toLocaleString()}. It won't be shown again.</small>
              </div>
            ) : (
              <button type="button" className="btn btn--sm" onClick={() => void makeCode()}>
                Create claim code
              </button>
            )}
          </div>
        </div>
      ) : null}
      {msg ? (
        <small role="status" className={msg.ok ? "pp-ok" : "pp-bad"}>
          {msg.text}
        </small>
      ) : null}
    </>
  );
}
