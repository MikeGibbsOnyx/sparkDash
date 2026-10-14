// Onyx Gateway: grants decide which models a caller may use. Access is the union of matching grants.

/** Glob with `*` only: "claude-*", "spark-1/*", "*". */
export function globMatch(pattern, value) {
  const re = new RegExp(`^${String(pattern).split("*").map((p) => p.replace(/[.+?^${}()|[\]\\/]/g, "\\$&")).join(".*")}$`, "i");
  return re.test(String(value));
}

/**
 * Does a caller match a selector?
 * @param {{ kind: string, login?: string | null, tags?: string[], keyName?: string | null, groups?: string[] }} who
 */
export function selectorMatches(selector, who) {
  const s = String(selector).trim();
  if (s === "*") return true;
  if (s === "local") return who.kind === "local";
  if (s.startsWith("group:")) return (who.groups || []).some((g) => g.toLowerCase() === s.slice(6).toLowerCase());
  if (s.startsWith("tag:")) return (who.tags || []).includes(s);
  if (s.startsWith("key:")) return Boolean(who.keyName) && who.keyName.toLowerCase() === s.slice(4).toLowerCase();
  return Boolean(who.login) && who.login.toLowerCase() === s.toLowerCase();
}

export class Grants {
  /** @param {import("better-sqlite3").Database} db */
  constructor(db, { now = Date.now, audit } = {}) {
    this.db = db;
    this.now = now;
    this.audit = audit || (() => {});
  }

  list() {
    return this.db.prepare("SELECT * FROM grants ORDER BY id").all().map((g) => ({
      id: g.id,
      name: g.name,
      selectors: JSON.parse(g.selectors),
      modelPatterns: JSON.parse(g.model_patterns),
      mcpPatterns: JSON.parse(g.mcp_patterns),
      updatedBy: g.updated_by,
      updatedAt: g.updated_at,
    }));
  }

  /** Enabling the Gateway creates "Everyone -> all models" once. */
  ensureDefault(actor) {
    if (this.db.prepare("SELECT 1 FROM grants LIMIT 1").get()) return false;
    this.db
      .prepare("INSERT INTO grants (name, selectors, model_patterns, mcp_patterns, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("Everyone", JSON.stringify(["*"]), JSON.stringify(["*"]), JSON.stringify(["*"]), actor, this.now());
    this.audit(actor, "grant.created", "Everyone", "* -> all models");
    return true;
  }

  /** Grants that apply to a caller. A key limited to one grant sees only that grant. */
  forCaller(who) {
    const all = this.list();
    if (who.onlyGrantId != null) return all.filter((g) => g.id === who.onlyGrantId);
    return all.filter((g) => g.selectors.some((s) => selectorMatches(s, who)));
  }

  allowsModel(who, modelName) {
    return this.forCaller(who).some((g) => g.modelPatterns.some((p) => globMatch(p, modelName)));
  }

  /** MCP tools are named <server>__<tool>; grants match them with their MCP patterns. */
  allowsTool(who, toolName) {
    return this.forCaller(who).some((g) => (g.mcpPatterns || []).some((p) => globMatch(p, toolName)));
  }

  // ─── Editing ────────────────────────────────────────────
  #validate(b) {
    const name = String(b.name || "").trim().slice(0, 80);
    if (!name) throw new GrantError(400, "Give the grant a name.");
    const list = (v) => (Array.isArray(v) ? v : String(v || "").split(/[,\n]/)).map((x) => String(x).trim()).filter(Boolean).slice(0, 200);
    const selectors = list(b.selectors);
    const modelPatterns = list(b.modelPatterns);
    const mcpPatterns = list(b.mcpPatterns ?? []);
    if (!selectors.length) throw new GrantError(400, "Say who the grant is for: *, a login, group:<name>, tag:<name>, key:<name> or local.");
    for (const sel of selectors) {
      if (!(sel === "*" || sel === "local" || /^(group|key):.+/.test(sel) || /^tag:[\w-]+$/.test(sel) || /^[^\s:]+$/.test(sel))) {
        throw new GrantError(400, `"${sel}" isn't a selector. Use *, a login, group:<name>, tag:<name>, key:<name> or local.`);
      }
    }
    if (!modelPatterns.length && !mcpPatterns.length) throw new GrantError(400, "Add at least one model pattern (such as claude-* or spark-1/*) or MCP tool pattern (such as github__*).");
    return { name, selectors, modelPatterns, mcpPatterns };
  }

  create(b, actor) {
    const v = this.#validate(b);
    const id = Number(
      this.db
        .prepare("INSERT INTO grants (name, selectors, model_patterns, mcp_patterns, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(v.name, JSON.stringify(v.selectors), JSON.stringify(v.modelPatterns), JSON.stringify(v.mcpPatterns), actor, this.now()).lastInsertRowid
    );
    this.audit(actor, "grant.created", v.name, `${v.selectors.join(", ")} -> ${v.modelPatterns.join(", ")}`);
    return this.list().find((g) => g.id === id);
  }

  update(id, b, actor) {
    const old = this.list().find((g) => g.id === id);
    if (!old) throw new GrantError(404, "That grant no longer exists.");
    const v = this.#validate({ ...old, ...b });
    this.db
      .prepare("UPDATE grants SET name = ?, selectors = ?, model_patterns = ?, mcp_patterns = ?, updated_by = ?, updated_at = ? WHERE id = ?")
      .run(v.name, JSON.stringify(v.selectors), JSON.stringify(v.modelPatterns), JSON.stringify(v.mcpPatterns), actor, this.now(), id);
    this.audit(actor, "grant.changed", v.name, `${v.selectors.join(", ")} -> ${v.modelPatterns.join(", ")}`);
    return this.list().find((g) => g.id === id);
  }

  remove(id, actor) {
    const old = this.list().find((g) => g.id === id);
    if (!old) throw new GrantError(404, "That grant no longer exists.");
    this.db.prepare("DELETE FROM grants WHERE id = ?").run(id);
    this.audit(actor, "grant.removed", old.name, null);
  }

  /**
   * Who would gain or lose which models if a grant were saved (or removed): compares access
   * now with access after, for every person in the directory and every gateway key.
   * @param {{ id?: number | null, draft?: object | null }} change  draft null = remove grant `id`
   * @param {{ directory: object, keys: Array<{ name: string, actsAs: string | null, access: string | null, state: string }>, models: string[] }} world
   */
  preview({ id = null, draft = null }, { directory, keys, models }) {
    const before = this.list();
    let after = before.filter((g) => g.id !== id);
    if (draft) {
      const v = this.#validate(draft);
      after = [...after, { id: id ?? -1, ...v }];
    }
    const callers = [
      ...(directory?.people || []).map((p) => ({ label: p.login, who: { kind: "person", login: p.login, tags: [] } })),
      ...keys.filter((k) => k.state !== "revoked" && k.state !== "expired" && !k.actsAs).map((k) => {
        const access = String(k.access || "");
        return { label: `key:${k.name}`, who: { kind: "key", login: null, keyName: k.name, tags: [], onlyGrantId: access.startsWith("grant:") ? Number(access.slice(6)) : null, extraGroups: access.startsWith("group:") ? [access.slice(6)] : [] } };
      }),
    ];
    const access = (grants, who) => {
      const mine = who.onlyGrantId != null ? grants.filter((g) => g.id === who.onlyGrantId) : grants.filter((g) => g.selectors.some((s) => selectorMatches(s, who)));
      return new Set(models.filter((m) => mine.some((g) => g.modelPatterns.some((p) => globMatch(p, m)))));
    };
    const changes = [];
    for (const c of callers) {
      c.who.groups = [...new Set([...groupsFor(directory, c.who), ...(c.who.extraGroups || [])])];
      const a = access(before, c.who);
      const b = access(after, c.who);
      const gains = [...b].filter((m) => !a.has(m));
      const losses = [...a].filter((m) => !b.has(m));
      if (gains.length || losses.length) changes.push({ caller: c.label, gains, losses });
    }
    return { changes };
  }
}

export class GrantError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Groups a caller belongs to, from the Observer's directory snapshot. */
export function groupsFor(directory, who) {
  const mine = new Set();
  for (const g of directory?.groups || []) {
    for (const m of g.members || []) {
      const sel = String(m);
      if ((who.login && sel.toLowerCase() === who.login.toLowerCase()) || (who.tags || []).includes(sel) || (who.keyName && sel.toLowerCase() === `key:${who.keyName}`.toLowerCase())) {
        mine.add(g.name);
      }
    }
  }
  return [...mine];
}
