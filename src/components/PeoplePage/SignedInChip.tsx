// Onyx: who is signed in, their role, and the way to the Connect page.
import { useAccess } from "./AccessContext";
import { CONNECT_PATH } from "./AccessGate";

export function SignedInChip() {
  const { me } = useAccess();
  if (!me?.signedIn) return null;
  const who = me.via === "local" ? "Local console" : me.via === "token" ? "Access token" : me.name || me.login || me.device || "Signed in";
  return (
    <div className="pp-signed" role="status" title={me.login ?? undefined}>
      <span className="pp-signed__who">
        {who} <span className={`pp-chip pp-chip--${me.role}`}>{me.roleLabel}</span>
      </span>
      <a className="pp-signed__link" href={CONNECT_PATH}>
        Switch to Connect page
      </a>
    </div>
  );
}

export function PeopleIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}
