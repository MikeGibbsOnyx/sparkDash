// Onyx: dashboard roles, lowest to highest.
export const ROLES = ["member", "auditor", "admin", "owner"];
export const ROLE_LABELS = { member: "Member", auditor: "Auditor", admin: "Admin", owner: "Owner" };

export function isRole(role) {
  return ROLES.includes(role);
}

/** True when `role` meets `min`. A missing role meets nothing. */
export function atLeast(role, min) {
  if (!isRole(role)) return false;
  return ROLES.indexOf(role) >= ROLES.indexOf(min);
}
