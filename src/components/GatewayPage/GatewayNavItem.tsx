// Onyx: the AI Gateway entry in the sidebar, with a status dot.
import { useEffect, useState } from "react";
import { fetchGatewayStatus, type GatewayStatus } from "./gatewayApi";

export function GatewayIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 12h4M16 12h4" />
      <rect x="8" y="7" width="8" height="10" rx="2" />
      <path d="M12 3v4M12 17v4" />
    </svg>
  );
}

type Dot = "on" | "paused" | "down" | null;

/** "on" (green), "paused" or "down" (amber), null while unknown. Polls once a minute. */
export function useGatewayDot(enabled = true): Dot {
  const [dot, setDot] = useState<Dot>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = () =>
      fetchGatewayStatus()
        .then((s) => alive && setDot(!s.gateway.up ? "down" : s.gateway.enabled ? "on" : "paused"))
        .catch(() => alive && setDot(null));
    void load();
    const t = setInterval(load, 60_000);
    const onStatus = (e: Event) => {
      const s = (e as CustomEvent<GatewayStatus>).detail;
      if (s) setDot(!s.gateway.up ? "down" : s.gateway.enabled ? "on" : "paused");
    };
    window.addEventListener("sparkdash:gateway-status", onStatus);
    return () => {
      alive = false;
      clearInterval(t);
      window.removeEventListener("sparkdash:gateway-status", onStatus);
    };
  }, [enabled]);
  return dot;
}

export function GatewayDot({ dot }: { dot: Dot }) {
  if (!dot) return null;
  const label = dot === "on" ? "Gateway on" : dot === "paused" ? "Gateway paused" : "Gateway not running";
  return <i className={`sdot ${dot === "on" ? "" : "sdot--warn"}`} style={{ marginLeft: "auto" }} role="img" aria-label={label} title={label} />;
}
