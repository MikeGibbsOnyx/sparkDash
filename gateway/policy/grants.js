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
