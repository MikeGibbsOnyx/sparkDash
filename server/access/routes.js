// Onyx: dashboard API for the signed-in person, People, groups, claim codes and access settings.
import { AccessError } from "./directory.js";
import { ROLES, ROLE_LABELS } from "./roles.js";

function handle(res, fn) {
  try {
    const out = fn();
    return res.json(out ?? { ok: true });
  } catch (err) {
    if (err instanceof AccessError) return res.status(err.status).json({ error: err.message });
    console.error("[access] route failed:", err?.message);
    return res.status(500).json({ error: "That didn't save. Check the server log." });
  }
}

/**
 * @param {import("express").Express} app
 * @param {{ directory: import("./directory.js").Directory, claims: import("./claims.js").ClaimCodes }} deps
 */
export function registerAccessRoutes(app, { directory, claims }) {
  /** Who am I. Public: a refused caller learns why and what to do. */
  app.get("/api/access/me", (req, res) => {
    const a = req.access;
    if (!a?.ok) return res.json({ signedIn: false, error: a?.error || "Not identified.", fix: a?.fix || "" });
    res.json({
      signedIn: true,
      via: a.via,
      login: a.login,
      name: a.name,
      device: a.device,
      role: a.role,
      roleLabel: a.role ? ROLE_LABELS[a.role] : null,
      tagged: Boolean(a.tagged),
      // A person may claim Owner with a code while nobody owns this install.
      canClaim: a.via !== "local" && Boolean(a.login) && !directory.hasOwner(),
    });
  });

  app.post("/api/access/claim", (req, res) => {
    const a = req.access;
    if (!a?.ok || !a.login) {
      return res.status(403).json({ error: "Claim codes are entered by a person Tailscale has identified.", fix: "Open sparkDash through Tailscale Serve and try again." });
    }
    const out = claims.redeem(req.body?.code, { login: a.login, name: a.name, device: a.device });
    if (!out.ok) return res.status(out.status).json({ error: out.error });
    res.json({ ok: true, role: out.person.role });
  });

  app.get("/api/access/people", (_req, res) => {
    res.json({ people: directory.list(), groups: directory.groups(), roles: ROLES.map((id) => ({ id, label: ROLE_LABELS[id] })) });
  });

  app.put("/api/access/people/:login/role", (req, res) => handle(res, () => ({ person: directory.setRole(req.access, req.params.login, req.body?.role) })));

  app.delete("/api/access/people/:login", (req, res) => handle(res, () => directory.remove(req.access, req.params.login)));

  app.post("/api/access/groups", (req, res) => handle(res, () => ({ group: directory.saveGroup(req.access, { name: req.body?.name, members: req.body?.members }) })));

  app.put("/api/access/groups/:id", (req, res) =>
    handle(res, () => ({ group: directory.saveGroup(req.access, { id: Number(req.params.id), name: req.body?.name, members: req.body?.members }) }))
  );

  app.delete("/api/access/groups/:id", (req, res) => handle(res, () => directory.deleteGroup(req.access, Number(req.params.id))));

  app.get("/api/access/settings", (_req, res) => res.json({ defaultRole: directory.defaultRole() }));

  app.put("/api/access/settings", (req, res) =>
    handle(res, () => {
      if (req.body?.defaultRole !== undefined) directory.setDefaultRole(req.access.label, req.body.defaultRole);
      return { defaultRole: directory.defaultRole() };
    })
  );

  app.post("/api/access/claim-codes", (req, res) => handle(res, () => claims.create(req.access.label)));

  app.get("/api/access/audit", (req, res) => res.json({ audit: directory.auditLog(Number(req.query.limit) || 100) }));
}
