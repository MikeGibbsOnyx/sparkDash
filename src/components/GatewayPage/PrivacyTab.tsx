// Onyx: Privacy and guardrails tab: capture mode and retention, detectors (off, flag, redact,
// block), Admins' regex detectors, a test box, tool blocking and the pre-request hook.
import { useCallback, useEffect, useState } from "react";
import {
  addDetector,
  fetchPrivacy,
  removeDetector,
  saveBlockedTools,
  saveCapture,
  saveHook,
  setDetectorMode,
  testDetectors,
  type CaptureSettings,
  type DetectorMode,
  type GuardrailConfig,
  type GuardrailHit,
} from "./gatewayApi";

const MODES: { key: DetectorMode; label: string }[] = [
  { key: "off", label: "Off" },
  { key: "flag", label: "Flag" },
  { key: "redact", label: "Redact" },
  { key: "block", label: "Block" },
];

export const FULL_CAPTURE_WARNING = "Everyone's prompts and responses will be stored on this machine for 7 days. Admins and Auditors can read them; each read is logged.";

function Capture({ c, canEdit, onSaved }: { c: CaptureSettings; canEdit: boolean; onSaved: (c: CaptureSettings) => void }) {
  const [confirming, setConfirming] = useState(false);
  const [bodies, setBodies] = useState(String(c.retention.bodiesDays));
  const [meta, setMeta] = useState(String(c.retention.metadataDays));
  const [error, setError] = useState<string | null>(null);
  const run = (p: Promise<{ capture: CaptureSettings }>) =>
    p.then(
      (r) => (onSaved(r.capture), setError(null), setConfirming(false)),
      (e) => setError(e instanceof Error ? e.message : String(e))
    );
  const warning = FULL_CAPTURE_WARNING.replace("7 days", `${c.retention.bodiesDays} day${c.retention.bodiesDays === 1 ? "" : "s"}`);
  return (
    <section className="panel gw-section" aria-label="Capture">
      <h2 className="gw-h2">What's recorded</h2>
      <div className="seg" role="radiogroup" aria-label="Capture mode">
        <button type="button" role="radio" aria-checked={c.mode === "metadata"} className={c.mode === "metadata" ? "is-on" : undefined} disabled={!canEdit} onClick={() => c.mode !== "metadata" && void run(saveCapture({ mode: "metadata" }))}>
          Metadata only
        </button>
        <button type="button" role="radio" aria-checked={c.mode === "full"} className={c.mode === "full" ? "is-on" : undefined} disabled={!canEdit} onClick={() => c.mode !== "full" && setConfirming(true)}>
          Full capture
        </button>
      </div>
      <p className="gw-muted gw-small">
        {c.mode === "metadata"
          ? "Time, person, device, tool, model, status, timing, tokens, cost and guardrail hits. Prompts and responses are never written to disk."
          : `Metadata, plus each request and response (gzip, up to 2 MB each), kept ${c.retention.bodiesDays} days.`}{" "}
        Authorization headers are never stored.
      </p>
      {confirming ? (
        <div className="gw-inline gw-confirm" role="alertdialog" aria-label="Turn on full capture">
          <p className="gw-warn">{warning}</p>
          <div className="gw-row">
            <button type="button" className="btn btn--sm btn--primary" onClick={() => void run(saveCapture({ mode: "full" }))}>
              Turn on full capture
            </button>
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      <form
        className="gw-row gw-retention"
        onSubmit={(e) => {
          e.preventDefault();
          void run(saveCapture({ retention: { bodiesDays: Number(bodies), metadataDays: Number(meta) } }));
        }}
      >
        <label>
          Keep content <input className="field-input mono gw-narrow" inputMode="numeric" value={bodies} disabled={!canEdit} onChange={(e) => setBodies(e.target.value)} aria-label="Days to keep content" /> days
        </label>
        <label>
          Keep request records <input className="field-input mono gw-narrow" inputMode="numeric" value={meta} disabled={!canEdit} onChange={(e) => setMeta(e.target.value)} aria-label="Days to keep request records" /> days
        </label>
        {canEdit ? (
          <button type="submit" className="btn btn--sm" disabled={bodies === String(c.retention.bodiesDays) && meta === String(c.retention.metadataDays)}>
            Save
          </button>
        ) : null}
      </form>
      <p className="gw-muted gw-small">Anything older is deleted hourly. Daily usage totals are kept, so spend history outlives the request log.</p>
      {error ? <p className="gw-bad">{error}</p> : null}
    </section>
  );
}

function Detectors({ g, canEdit, onSaved }: { g: GuardrailConfig; canEdit: boolean; onSaved: (g: GuardrailConfig) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [pattern, setPattern] = useState("");
  const [mode, setMode] = useState<DetectorMode>("flag");
  const run = (p: Promise<{ guardrails: GuardrailConfig }>) =>
    p.then(
      (r) => (onSaved(r.guardrails), setError(null)),
      (e) => setError(e instanceof Error ? e.message : String(e))
    );
  const anyRedact = g.detectors.some((d) => d.mode === "redact");
  return (
    <section className="panel gw-section" aria-label="Detectors">
      <div className="gw-section__head">
        <h2 className="gw-h2">Detectors</h2>
        {canEdit && !adding ? (
          <button type="button" className="btn btn--sm" onClick={() => setAdding(true)}>
            Add a pattern
          </button>
        ) : null}
      </div>
      <p className="gw-muted gw-small">
        Checked before a request leaves this machine: message and system text, and tool results. Never thinking blocks, signatures, images or tool definitions. <b>Flag</b> records a hit. <b>Redact</b> replaces the value with a placeholder such as [EMAIL_1], the same one every turn. <b>Block</b> refuses the request and names the detector, never the text.
      </p>
      {anyRedact ? <p className="gw-warn gw-small">Redaction changes what the model reads, which can confuse Claude's extended thinking. For coding agents, Flag or Block is usually the better choice.</p> : null}
      <ul className="gw-list">
        {g.detectors.map((d) => (
          <li key={d.id}>
            <div>
              <b>{d.name}</b>
              {d.builtin ? null : <div className="mono gw-small">/{d.pattern}/{d.flags}</div>}
            </div>
            <div className="gw-row">
              <div className="seg" role="radiogroup" aria-label={`${d.name} mode`}>
                {MODES.map((m) => (
                  <button key={m.key} type="button" role="radio" aria-checked={d.mode === m.key} className={d.mode === m.key ? "is-on" : undefined} disabled={!canEdit} onClick={() => d.mode !== m.key && void run(setDetectorMode(d.id, m.key))}>
                    {m.label}
                  </button>
                ))}
              </div>
              {canEdit && !d.builtin ? (
                <button type="button" className="btn btn--sm btn--ghost" onClick={() => window.confirm(`Remove the detector ${d.name}?`) && void run(removeDetector(d.id))}>
                  Remove
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {adding ? (
        <form
          className="panel gw-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(addDetector({ name, pattern, mode })).then(() => (setAdding(false), setName(""), setPattern("")));
          }}
        >
          <h3 className="gw-h3">New pattern</h3>
          <label>
            <span>Name</span>
            <input className="field-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Project code" autoFocus />
          </label>
          <label>
            <span>Regular expression</span>
            <input className="field-input mono" value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="PRJ-\d{4}" />
          </label>
          <label>
            <span>When found</span>
            <select className="field-input" value={mode} onChange={(e) => setMode(e.target.value as DetectorMode)}>
              {MODES.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <p className="gw-muted gw-small">Try it in the test box below first. A pattern that backtracks heavily slows every request.</p>
          <div className="gw-row">
            <button type="submit" className="btn btn--sm btn--primary" disabled={!name.trim() || !pattern}>
              Add pattern
            </button>
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}
      <TestBox draftPattern={adding ? pattern : ""} />
      {error ? <p className="gw-bad">{error}</p> : null}
    </section>
  );
}

function TestBox({ draftPattern }: { draftPattern: string }) {
  const [text, setText] = useState("");
  const [result, setResult] = useState<{ redacted: string; hits: GuardrailHit[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="gw-testbox">
      <label className="gw-label" htmlFor="gw-test-text">
        Test on sample text
      </label>
      <textarea id="gw-test-text" className="field-input mono" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste text with an email, a card number, a key…" />
      <div className="gw-row">
        <button
          type="button"
          className="btn btn--sm"
          disabled={!text.trim()}
          onClick={() =>
            void testDetectors(text, draftPattern || undefined).then(
              (r) => (setResult(r), setError(null)),
              (e) => setError(e instanceof Error ? e.message : String(e))
            )
          }
        >
          Test
        </button>
        <span className="gw-muted gw-small">Every detector runs here, whatever its mode. Nothing is stored.</span>
      </div>
      {result ? (
        <div role="status">
          <p className="gw-small">{result.hits.length ? result.hits.map((h) => `${h.name}: ${h.count}`).join(" · ") : "Nothing found."}</p>
          {result.hits.length ? <pre className="mono gw-pre">{result.redacted}</pre> : null}
        </div>
      ) : null}
      {error ? <p className="gw-bad gw-small">{error}</p> : null}
    </div>
  );
}

function ToolsAndHook({ g, canEdit, onSaved }: { g: GuardrailConfig; canEdit: boolean; onSaved: (g: GuardrailConfig) => void }) {
  const [tools, setTools] = useState(g.blockedTools.join("\n"));
  const [url, setUrl] = useState(g.hook?.url ?? "");
  const [failOpen, setFailOpen] = useState(g.hook?.failOpen ?? true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const run = (p: Promise<{ guardrails: GuardrailConfig }>, what: string) =>
    p.then(
      (r) => (onSaved(r.guardrails), setError(null), setSaved(what)),
      (e) => (setError(e instanceof Error ? e.message : String(e)), setSaved(null))
    );
  return (
    <section className="panel gw-section" aria-label="Tool blocking and hook">
      <h2 className="gw-h2">Tool blocking</h2>
      <p className="gw-muted gw-small">Tools with these names are removed from requests before they reach the model, one name or pattern per line (for example <span className="mono">Bash</span> or <span className="mono">mcp__github__delete_*</span>).</p>
      <textarea className="field-input mono" rows={3} value={tools} disabled={!canEdit} onChange={(e) => setTools(e.target.value)} aria-label="Blocked tools" />
      {canEdit ? (
        <div className="gw-row">
          <button type="button" className="btn btn--sm" onClick={() => void run(saveBlockedTools(tools.split("\n").map((s) => s.trim()).filter(Boolean)), "Blocked tools saved.")}>
            Save blocked tools
          </button>
        </div>
      ) : null}

      <h2 className="gw-h2">Pre-request hook</h2>
      <p className="gw-muted gw-small">
        Optional. Each request is sent to this URL first, which answers <span className="mono">{'{"action":"allow"}'}</span>, <span className="mono">{'{"action":"block","message":"…"}'}</span> or <span className="mono">{'{"action":"replace","body":{…}}'}</span> within 2 seconds.
      </p>
      <input className="field-input mono" value={url} disabled={!canEdit} onChange={(e) => setUrl(e.target.value)} placeholder="http://10.0.0.5:9000/check" aria-label="Hook URL" />
      <label className="gw-switch">
        <input type="checkbox" checked={failOpen} disabled={!canEdit} onChange={(e) => setFailOpen(e.target.checked)} /> If the hook doesn't answer, let the request through (otherwise it's refused)
      </label>
      {g.hook && !g.hook.private ? <p className="gw-warn gw-small">This URL is outside your loopback, LAN and tailnet. Every prompt is sent to it.</p> : null}
      {canEdit ? (
        <div className="gw-row">
          <button type="button" className="btn btn--sm" onClick={() => void run(saveHook(url.trim() ? { url: url.trim(), failOpen } : null), url.trim() ? "Hook saved." : "Hook removed.")}>
            {url.trim() ? "Save hook" : "Remove hook"}
          </button>
        </div>
      ) : null}
      {saved ? <p className="gw-ok gw-small" role="status">{saved}</p> : null}
      {error ? <p className="gw-bad">{error}</p> : null}
    </section>
  );
}

export function PrivacyTab({ canEdit }: { canEdit: boolean }) {
  const [capture, setCapture] = useState<CaptureSettings | null>(null);
  const [g, setG] = useState<GuardrailConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    fetchPrivacy().then(
      (r) => (setCapture(r.capture), setG(r.guardrails), setError(null)),
      (e) => setError(e instanceof Error ? e.message : String(e))
    );
  }, []);
  useEffect(load, [load]);
  return (
    <div className="gw-tab">
      {error ? <p className="gw-bad">{error}</p> : null}
      {capture ? <Capture c={capture} canEdit={canEdit} onSaved={setCapture} /> : null}
      {g ? <Detectors g={g} canEdit={canEdit} onSaved={setG} /> : null}
      {g ? <ToolsAndHook g={g} canEdit={canEdit} onSaved={setG} /> : null}
    </div>
  );
}
