// Onyx: decides what a person sees. Members and refused callers never get the fleet pages.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { onTokenChange } from "../../api/authToken";
import { fetchMe, redeemClaimCode, type Me } from "./accessApi";
import { AccessContext } from "./AccessContext";
import "./people.css";

/** Path of the Connect page placeholder until the Gateway serves the real one (Phase 2). */
export const CONNECT_PATH = "/connect";

export function AccessGate({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(() => {
    fetchMe()
      .then((m) => {
        setMe(m);
        setLoadError(null);
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    reload();
    return onTokenChange(() => reload());
  }, [reload]);

  let body: ReactNode;
  if (loadError && !me) {
    body = (
      <AccessScreen title="sparkDash isn't answering">
        <p>{loadError}</p>
        <p>Check that sparkDash is running, then reload.</p>
      </AccessScreen>
    );
  } else if (!me) {
    body = null;
  } else if (!me.signedIn) {
    body = (
      <AccessScreen title="sparkDash can't tell who you are">
        <p>{me.error}</p>
        <p className="pp-fix">{me.fix}</p>
      </AccessScreen>
    );
  } else if (me.tagged && !me.role) {
    body = (
      <AccessScreen title="This is a tagged device">
        <p>{me.device || "This device"} is tagged in Tailscale, so it can't use the dashboard.</p>
        <p className="pp-fix">Open sparkDash from your own device.</p>
      </AccessScreen>
    );
  } else if (me.role === "member" || window.location.pathname === CONNECT_PATH) {
    body = <ConnectPlaceholder me={me} onClaimed={reload} />;
  } else {
    body = (
      <>
        {me.canClaim ? <ClaimBanner onClaimed={reload} /> : null}
        {children}
      </>
    );
  }

  return <AccessContext.Provider value={{ me, reload }}>{body}</AccessContext.Provider>;
}

function AccessScreen({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="pp-screen">
      <div className="panel pp-screen__card" role="alert">
        <h1>{title}</h1>
        {children}
      </div>
    </main>
  );
}

/** What a Member sees until the Gateway's Connect page arrives in Phase 2. */
function ConnectPlaceholder({ me, onClaimed }: { me: Extract<Me, { signedIn: true }>; onClaimed: () => void }) {
  const back = me.role && me.role !== "member";
  return (
    <main className="pp-screen">
      <div className="panel pp-screen__card">
        <p className="pp-screen__who">
          {me.name || me.login || "You"} · {me.roleLabel}
          {me.device ? ` · ${me.device}` : ""}
        </p>
        <h1>Connect page</h1>
        <p>This is where you'll connect Claude Code, Codex and other AI tools to your team's gateway, and see your own usage. It isn't switched on yet.</p>
        {me.role === "member" ? <p>The fleet dashboard is for Admins and Auditors. If you need it, ask an Owner or Admin to change your role on the People page.</p> : null}
        {back ? (
          <p>
            <a className="btn btn--sm" href="/">
              Back to the dashboard
            </a>
          </p>
        ) : null}
      </div>
      {me.canClaim ? <ClaimBanner onClaimed={onClaimed} /> : null}
    </main>
  );
}

/** Shown while no one owns the install: the server log has a one-time code. */
export function ClaimBanner({ onClaimed }: { onClaimed: () => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const submit = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await redeemClaimCode(code);
      setMsg({ ok: true, text: "You're the Owner of this sparkDash." });
      setCode("");
      onClaimed();
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="panel pp-claim"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label htmlFor="pp-claim-code">
        <b>No one owns this sparkDash yet.</b> Enter the claim code from the server log to become its Owner.
      </label>
      <div className="pp-claim__row">
        <input
          id="pp-claim-code"
          className="field-input mono"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="XXXX-XXXX-XXXX"
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit" className="btn btn--primary btn--sm" disabled={busy || code.trim().length < 12}>
          Claim
        </button>
      </div>
      <small role="status" className={msg ? (msg.ok ? "pp-ok" : "pp-bad") : undefined}>
        {msg?.text ?? ""}
      </small>
    </form>
  );
}
