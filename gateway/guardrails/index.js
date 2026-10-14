// Onyx Gateway: guardrails, run before a request leaves the machine. Each detector is Off, Flag
// (record only), Redact (a stable placeholder such as [EMAIL_1]) or Block (a 400 naming the
// detector, never the matched text). Admins can also remove tools by name and add a pre-request
// hook. Redaction is deterministic within a request: values are numbered in the order they first
// appear, so a conversation's history redacts the same way every turn.
import { globMatch } from "../policy/grants.js";
import { BUILTIN, BUILTIN_IDS, compileCustom, findAll } from "./detectors.js";
import { removeTools, textSlots } from "./scan.js";

export const MODES = ["off", "flag", "redact", "block"];
const HOOK_TIMEOUT_MS = 2000;

export class GuardrailError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Is a hook URL somewhere the business controls (loopback, LAN or tailnet)? */
export function hookUrlIsPrivate(raw) {
  try {
    const h = new URL(raw).hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
    if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".ts.net") || h.endsWith(".local") || h.endsWith(".lan") || h.endsWith(".internal")) return true;
    if (/^127\.|^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
    const m = /^100\.(\d+)\./.exec(h);
    if (m && Number(m[1]) >= 64 && Number(m[1]) <= 127) return true;
    if (h === "::1" || /^f[cd]/.test(h) || /^fd7a:115c:a1e0:/.test(h)) return true;
    return false;
  } catch {
    return false;
  }
}

export class Guardrails {
  /**
   * @param {import("better-sqlite3").Database} db
   * @param {{ state: import("../store/state.js").State, audit?: Function, fetchImpl?: typeof fetch, checkUrl?: (url: string) => Promise<string | null> }} deps
   */
  constructor(db, { state, audit, fetchImpl = fetch, checkUrl = async () => null }) {
    this.db = db;
    this.state = state;
    this.audit = audit || (() => {});
    this.fetch = fetchImpl;
    this.checkUrl = checkUrl;
    this._compiled = null;
  }

  // ─── Configuration ──────────────────────────────────────
  modes() {
    const saved = this.state.get("guardrail_modes", {}) || {};
    return Object.fromEntries(BUILTIN_IDS.map((id) => [id, MODES.includes(saved[id]) ? saved[id] : "off"]));
  }

  blockedTools() {
    return this.state.get("blocked_tools", []) || [];
  }

  hook() {
    const h = this.state.get("guardrail_hook", null);
    return h && h.url ? { url: h.url, failOpen: h.failOpen !== false, private: hookUrlIsPrivate(h.url) } : null;
  }

  customDetectors() {
    return this.db.prepare("SELECT * FROM detectors ORDER BY id").all().map((d) => ({ id: d.id, name: d.name, pattern: d.pattern, flags: d.flags, mode: d.mode, updatedBy: d.updated_by, updatedAt: d.updated_at }));
  }

  /** Everything the Privacy and guardrails tab shows. */
  config() {
    const modes = this.modes();
    return {
      detectors: [...BUILTIN.map((d) => ({ id: d.id, name: d.name, builtin: true, mode: modes[d.id] })), ...this.customDetectors().map((d) => ({ ...d, id: `custom:${d.id}`, builtin: false }))],
      blockedTools: this.blockedTools(),
      hook: this.hook(),
    };
  }

  /** @returns {Array<{ id: string, name: string, label: string, re: RegExp, valid?: Function, mode: string }>} */
  active() {
    if (this._compiled) return this._compiled;
    const modes = this.modes();
    const list = BUILTIN.filter((d) => modes[d.id] !== "off").map((d) => ({ ...d, mode: modes[d.id] }));
    for (const c of this.customDetectors()) {
      if (c.mode === "off") continue;
      try {
        list.push({ ...compileCustom({ id: `custom:${c.id}`, name: c.name, pattern: c.pattern, flags: c.flags }), mode: c.mode });
      } catch {
        /* saved patterns were validated; skip one that no longer compiles */
      }
    }
    this._compiled = list;
    return list;
  }

  #changed() {
    this._compiled = null;
  }

  setMode(id, mode, actor) {
    if (!MODES.includes(mode)) throw new GuardrailError(400, "The mode must be off, flag, redact or block.");
    if (String(id).startsWith("custom:")) {
      const n = Number(String(id).slice(7));
      const row = this.db.prepare("SELECT name FROM detectors WHERE id = ?").get(n);
      if (!row) throw new GuardrailError(404, "That detector no longer exists.");
      this.db.prepare("UPDATE detectors SET mode = ?, updated_by = ?, updated_at = ? WHERE id = ?").run(mode, actor, Date.now(), n);
      this.audit(actor, "guardrail.mode", row.name, mode);
    } else {
      const d = BUILTIN.find((x) => x.id === id);
      if (!d) throw new GuardrailError(404, "There's no detector with that name.");
      this.state.set("guardrail_modes", { ...this.modes(), [id]: mode });
      this.audit(actor, "guardrail.mode", d.name, mode);
    }
    this.#changed();
    return this.config();
  }

  addDetector({ name, pattern, flags, mode = "flag" }, actor) {
    const n = String(name || "").trim().slice(0, 60);
    if (!n) throw new GuardrailError(400, "Give the detector a name.");
    if (!MODES.includes(mode)) throw new GuardrailError(400, "The mode must be off, flag, redact or block.");
    try {
      compileCustom({ id: "x", name: n, pattern, flags });
    } catch (err) {
      throw new GuardrailError(400, err.message);
    }
    this.db.prepare("INSERT INTO detectors (name, pattern, flags, mode, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(n, String(pattern), String(flags || ""), mode, actor, Date.now());
    this.audit(actor, "guardrail.detector_added", n, mode);
    this.#changed();
    return this.config();
  }

  removeDetector(id, actor) {
    const row = this.db.prepare("SELECT name FROM detectors WHERE id = ?").get(id);
    if (!row) throw new GuardrailError(404, "That detector no longer exists.");
    this.db.prepare("DELETE FROM detectors WHERE id = ?").run(id);
    this.audit(actor, "guardrail.detector_removed", row.name, null);
    this.#changed();
    return this.config();
  }

  setBlockedTools(list, actor) {
    const clean = (Array.isArray(list) ? list : String(list || "").split(/[,\n]/)).map((s) => String(s).trim()).filter(Boolean).slice(0, 200);
    this.state.set("blocked_tools", clean);
    this.audit(actor, "guardrail.blocked_tools", null, clean.join(", ") || "none");
    return this.config();
  }

  async setHook(h, actor) {
    if (!h || !h.url) {
      this.state.set("guardrail_hook", null);
      this.audit(actor, "guardrail.hook", null, "off");
      return this.config();
    }
    const problem = await this.checkUrl(String(h.url));
    if (problem) throw new GuardrailError(400, problem);
    this.state.set("guardrail_hook", { url: String(h.url), failOpen: h.failOpen !== false });
    this.audit(actor, "guardrail.hook", String(h.url), h.failOpen !== false ? "fail open" : "fail closed");
    return this.config();
  }

  // ─── Running ────────────────────────────────────────────
  /** Anything to do at all? When not, requests skip guardrails entirely (no parse, no copy). */
  get enabled() {
    return this.active().length > 0 || this.blockedTools().length > 0 || Boolean(this.hook());
  }

  /**
   * Scan and change text with the active detectors. Mutates `body`.
   * @returns {{ hits: Array<{ detector: string, name: string, action: string, count: number }>, blockedBy: string[], changed: boolean }}
   */
  scan(format, body, detectors = this.active()) {
    const slots = textSlots(format, body);
    const hits = new Map();
    const blockedBy = [];
    let changed = false;
    for (const d of detectors) {
      const numbering = new Map();
      let count = 0;
      for (const slot of slots) {
        const text = slot.get();
        const found = findAll(d, text);
        if (!found.length) continue;
        count += found.length;
        if (d.mode === "redact") {
          for (const f of found) if (!numbering.has(f.value)) numbering.set(f.value, numbering.size + 1);
          let out = text;
          for (let i = found.length - 1; i >= 0; i--) {
            const f = found[i];
            out = `${out.slice(0, f.start)}[${d.label}_${numbering.get(f.value)}]${out.slice(f.end)}`;
          }
          slot.set(out);
          changed = true;
        }
      }
      if (count) {
        hits.set(d.id, { detector: d.id, name: d.name, action: d.mode === "redact" ? "redacted" : d.mode === "block" ? "blocked" : "flagged", count });
        if (d.mode === "block") blockedBy.push(d.name);
      }
    }
    return { hits: [...hits.values()], blockedBy, changed };
  }

  /**
   * Apply every guardrail to a parsed request body.
   * @returns {Promise<{ action: "pass" | "block", body: object | null, hits: object[], removedTools: string[], message?: string, hookError?: string }>}
   *          body is the changed request (null when unchanged).
   */
  async apply({ format, parsed, who, model }) {
    if (!parsed || typeof parsed !== "object") return { action: "pass", body: null, hits: [], removedTools: [] };
    const body = structuredClone(parsed);
    let changed = false;

    const patterns = this.blockedTools();
    const removedTools = patterns.length ? removeTools(format, body, (n) => patterns.some((p) => globMatch(p, n))) : [];
    if (removedTools.length) changed = true;

    const { hits, blockedBy, changed: redacted } = this.scan(format, body);
    if (redacted) changed = true;
    if (blockedBy.length) {
      return {
        action: "block",
        body: null,
        hits,
        removedTools,
        message: `The gateway blocked this request: it contains ${blockedBy.length === 1 ? "something" : "things"} its guardrails don't allow out (${blockedBy.join(", ")}). Remove ${blockedBy.length === 1 ? "it" : "them"} and try again, or ask an Admin.`,
      };
    }

    const hook = this.hook();
    if (hook) {
      const r = await this.#callHook(hook, { format, model, identity: who?.label ?? null, body });
      if (r.error) {
        hits.push({ detector: "hook", name: "Pre-request hook", action: hook.failOpen ? "failed open" : "failed closed", count: 1 });
        if (!hook.failOpen) return { action: "block", body: null, hits, removedTools, message: "The gateway's pre-request check didn't answer, and it is set to refuse requests then. Try again shortly, or ask an Admin.", hookError: r.error };
      } else if (r.action === "block") {
        hits.push({ detector: "hook", name: "Pre-request hook", action: "blocked", count: 1 });
        return { action: "block", body: null, hits, removedTools, message: r.message ? `The gateway blocked this request: ${String(r.message).slice(0, 500)}` : "The gateway's pre-request check blocked this request." };
      } else if (r.action === "replace") {
        hits.push({ detector: "hook", name: "Pre-request hook", action: "replaced", count: 1 });
        return { action: "pass", body: r.body, hits, removedTools };
      }
    }
    return { action: "pass", body: changed ? body : null, hits, removedTools };
  }

  async #callHook(hook, payload) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), HOOK_TIMEOUT_MS);
    try {
      const res = await this.fetch(hook.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: ac.signal, redirect: "error" });
      if (!res.ok) return { error: `HTTP ${res.status}` };
      const j = await res.json();
      if (j?.action === "allow") return { action: "allow" };
      if (j?.action === "block") return { action: "block", message: typeof j.message === "string" ? j.message : null };
      if (j?.action === "replace" && j.body && typeof j.body === "object") return { action: "replace", body: j.body };
      return { error: "unrecognised answer" };
    } catch (err) {
      return { error: err?.name === "AbortError" ? "timed out" : err?.code || err?.message || "failed" };
    } finally {
      clearTimeout(t);
    }
  }

  /** The detector test box: what each active-or-not detector finds in sample text. Nothing is stored. */
  test(text, { pattern, flags } = {}) {
    const sample = String(text || "").slice(0, 20_000);
    const all = [...BUILTIN.map((d) => ({ ...d, mode: "redact" }))];
    for (const c of this.customDetectors()) {
      try {
        all.push({ ...compileCustom({ id: `custom:${c.id}`, name: c.name, pattern: c.pattern, flags: c.flags }), mode: "redact" });
      } catch {
        /* skip */
      }
    }
    if (pattern) {
      try {
        all.push({ ...compileCustom({ id: "draft", name: "New detector", pattern, flags }), mode: "redact" });
      } catch (err) {
        throw new GuardrailError(400, err.message);
      }
    }
    const body = { messages: [{ role: "user", content: sample }] };
    const { hits } = this.scan("openai-chat", body, all);
    return { redacted: body.messages[0].content, hits };
  }
}
