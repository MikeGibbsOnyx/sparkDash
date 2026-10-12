// Onyx: people, groups, roles and the Observer audit trail.
import { ROLE_LABELS, atLeast, isRole } from "./roles.js";

const SELECTOR = /^(tag:[a-z0-9-]+|key:[a-z0-9_.-]+|[^\s:@]+@[^\s:@]+)$/i;

export class AccessError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export class Directory {
  /**
   * @param {import("better-sqlite3").Database} db
   * @param {{ now?: () => number, onEvent?: (event: object) => void, onChange?: () => void }} [opts]
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.now = opts.now || Date.now;
    this.onEvent = opts.onEvent || (() => {});
    // Fires after anything the Gateway's directory snapshot depends on changes (Phase 2 push).
    this.onChange = opts.onChange || (() => {});
  }

  // ─── Settings ───────────────────────────────────────────
  defaultRole() {
    const row = this.db.prepare("SELECT value FROM access_settings WHERE key = 'default_role'").get();
    return row && isRole(row.value) && row.value !== "owner" ? row.value : "member";
  }

  setDefaultRole(actor, role) {
    if (!isRole(role) || role === "owner") throw new AccessError(400, "Default role must be Member, Auditor or Admin.");
    const before = this.defaultRole();
    this.db.prepare("INSERT INTO access_settings (key, value) VALUES ('default_role', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(role);
    if (before !== role) this.audit(actor, "settings.default_role", null, `${before} -> ${role}`, `Default role for new people set to ${ROLE_LABELS[role]}`);
  }

  // ─── People ─────────────────────────────────────────────
  get(login) {
    return this.db.prepare("SELECT * FROM people WHERE login = ?").get(login) || null;
  }

  hasOwner() {
    return Boolean(this.db.prepare("SELECT 1 FROM people WHERE role = 'owner' LIMIT 1").get());
  }

  /** Record that a person was seen; a first sighting gets the default role. Returns the person. */
  seen({ login, name, device }) {
    const now = this.now();
    const existing = this.get(login);
    if (existing) {
      // Writing on every request is wasteful; a minute's resolution is enough for "last seen".
      if (now - existing.last_seen > 60_000 || (name && name !== existing.display_name) || (device && device !== existing.last_device)) {
        this.db
          .prepare("UPDATE people SET last_seen = ?, display_name = COALESCE(?, display_name), last_device = COALESCE(?, last_device) WHERE id = ?")
          .run(now, name || null, device || null, existing.id);
      }
      return this.get(login);
    }
    const role = this.defaultRole();
    this.db
      .prepare("INSERT INTO people (login, display_name, role, first_seen, last_seen, last_device) VALUES (?, ?, ?, ?, ?, ?)")
      .run(login, name || null, role, now, now, device || null);
    this.audit("sparkDash", "person.first_seen", login, role, `${name || login} opened sparkDash for the first time (${ROLE_LABELS[role]})`);
    this.onChange();
    return this.get(login);
  }

  list() {
    const people = this.db.prepare("SELECT * FROM people ORDER BY last_seen DESC").all();
    const groupsBySelector = new Map();
    for (const row of this.db.prepare("SELECT g.name, m.selector FROM group_members m JOIN groups g ON g.id = m.group_id").all()) {
      const key = row.selector.toLowerCase();
      if (!groupsBySelector.has(key)) groupsBySelector.set(key, []);
      groupsBySelector.get(key).push(row.name);
    }
    return people.map((p) => ({
      login: p.login,
      displayName: p.display_name,
      role: p.role,
      firstSeen: p.first_seen,
      lastSeen: p.last_seen,
      lastDevice: p.last_device,
      groups: groupsBySelector.get(p.login.toLowerCase()) || [],
    }));
  }

  /**
   * Change a person's role. Admins manage everyone but Owners; only an Owner can make or unmake one.
   * @param {{ label: string, role: string }} actor
   */
  setRole(actor, login, role) {
    if (!isRole(role)) throw new AccessError(400, `Unknown role "${role}".`);
    const person = this.get(login);
    if (!person) throw new AccessError(404, `No one called ${login} has opened sparkDash yet.`);
    if ((role === "owner" || person.role === "owner") && !atLeast(actor.role, "owner")) {
      throw new AccessError(403, "Only an Owner can make someone an Owner or change an Owner's role.");
    }
    if (!atLeast(actor.role, "admin")) throw new AccessError(403, "Changing roles needs the Admin role.");
    if (person.role === role) return this.get(login);
    this.db.prepare("UPDATE people SET role = ? WHERE id = ?").run(role, person.id);
    this.audit(actor.label, "person.role", person.login, `${person.role} -> ${role}`, `${actor.label} changed ${person.display_name || person.login} from ${ROLE_LABELS[person.role]} to ${ROLE_LABELS[role]}`);
    this.onChange();
    return this.get(login);
  }

  remove(actor, login) {
    const person = this.get(login);
    if (!person) throw new AccessError(404, `No one called ${login} is on the People list.`);
    if (person.role === "owner" && !atLeast(actor.role, "owner")) throw new AccessError(403, "Only an Owner can remove an Owner.");
    this.db.prepare("DELETE FROM people WHERE id = ?").run(person.id);
    this.audit(actor.label, "person.removed", person.login, person.role, `${actor.label} removed ${person.display_name || person.login} from People (they get the default role if they come back)`);
    this.onChange();
  }

  /** Give a person a role directly (claim codes). Creates them if needed. */
  grant(actorLabel, identity, role) {
    const person = this.seen(identity);
    if (person.role !== role) {
      this.db.prepare("UPDATE people SET role = ? WHERE id = ?").run(role, person.id);
      this.audit(actorLabel, "person.role", person.login, `${person.role} -> ${role}`, `${person.display_name || person.login} became ${ROLE_LABELS[role]} with a claim code`);
      this.onChange();
    }
    return this.get(person.login);
  }

  // ─── Groups ─────────────────────────────────────────────
  groups() {
    const groups = this.db.prepare("SELECT * FROM groups ORDER BY name").all();
    const members = this.db.prepare("SELECT selector FROM group_members WHERE group_id = ? ORDER BY selector");
    return groups.map((g) => ({ id: g.id, name: g.name, members: members.all(g.id).map((m) => m.selector) }));
  }

  saveGroup(actor, { id, name, members }) {
    const clean = String(name || "").trim();
    if (!/^[a-z0-9][a-z0-9 _.-]{0,39}$/i.test(clean)) throw new AccessError(400, "Group names are 1–40 letters, numbers, spaces, dots, dashes or underscores.");
    const selectors = [...new Set((members || []).map((m) => String(m).trim()).filter(Boolean))];
    const bad = selectors.find((s) => !SELECTOR.test(s));
    if (bad) throw new AccessError(400, `"${bad}" isn't a login, tag:<name> or key:<name>.`);
    const save = this.db.transaction(() => {
      let groupId = id;
      if (groupId) {
        const res = this.db.prepare("UPDATE groups SET name = ? WHERE id = ?").run(clean, groupId);
        if (!res.changes) throw new AccessError(404, "That group no longer exists.");
        this.db.prepare("DELETE FROM group_members WHERE group_id = ?").run(groupId);
      } else {
        groupId = Number(this.db.prepare("INSERT INTO groups (name) VALUES (?)").run(clean).lastInsertRowid);
      }
      const add = this.db.prepare("INSERT INTO group_members (group_id, selector) VALUES (?, ?)");
      for (const s of selectors) add.run(groupId, s);
      return groupId;
    });
    let groupId;
    try {
      groupId = save();
    } catch (err) {
      if (/UNIQUE/.test(err.message)) throw new AccessError(409, `A group called "${clean}" already exists.`);
      throw err;
    }
    this.audit(actor.label, id ? "group.updated" : "group.created", clean, selectors.join(", "), `${actor.label} ${id ? "updated" : "created"} group ${clean} (${selectors.length} member${selectors.length === 1 ? "" : "s"})`);
    this.onChange();
    return this.groups().find((g) => g.id === groupId);
  }

  deleteGroup(actor, id) {
    const group = this.db.prepare("SELECT * FROM groups WHERE id = ?").get(id);
    if (!group) throw new AccessError(404, "That group no longer exists.");
    this.db.prepare("DELETE FROM groups WHERE id = ?").run(id);
    this.audit(actor.label, "group.deleted", group.name, null, `${actor.label} deleted group ${group.name}`);
    this.onChange();
  }

  // ─── Audit ──────────────────────────────────────────────
  audit(actor, action, target, detail, message) {
    this.db.prepare("INSERT INTO audit (ts, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)").run(this.now(), actor, action, target ?? null, detail ?? null);
    if (message) {
      try {
        this.onEvent({ type: `access.${action}`, severity: "info", message });
      } catch {
        /* Activity must never break an access change */
      }
    }
  }

  auditLog(limit = 100) {
    return this.db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT ?").all(Math.min(Math.max(1, limit), 1000));
  }
}
