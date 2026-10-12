// Onyx: the minimum role for every dashboard route.
//
// Reads need Auditor and every change needs Admin, so a route added upstream is
// covered the day it lands. The few exceptions are listed here, and
// __tests__/routeRoles.test.js checks every route declared in server/ against this.

/** Routes anyone may call, including a refused caller (they explain what to do). */
const PUBLIC = [
  ["GET", /^\/api\/auth\/status$/],
  ["GET", /^\/api\/access\/me$/],
  ["POST", /^\/api\/access\/claim$/],
];

/** Exceptions to "GET needs Auditor, anything else needs Admin". */
const OVERRIDES = [
  // Making an Owner claim code hands out Owner rights.
  ["POST", /^\/api\/access\/claim-codes$/, "owner"],
];

const isRead = (method) => method === "GET" || method === "HEAD";

/**
 * Minimum role for a request, or null when it is public.
 * Non-API paths (the SPA shell and its assets) are public: they carry no fleet data,
 * and a Member's browser must load the app to be sent to the Connect page.
 * @param {string} method
 * @param {string} path
 * @returns {"member" | "auditor" | "admin" | "owner" | null}
 */
export function minRoleFor(method, path) {
  const m = String(method || "GET").toUpperCase();
  const p = String(path || "/");
  if (!/^\/(api|ws|metrics)(\/|$)/.test(p)) return null;
  for (const [pm, re] of PUBLIC) if ((pm === m || (pm === "GET" && m === "HEAD")) && re.test(p)) return null;
  for (const [om, re, role] of OVERRIDES) if (om === m && re.test(p)) return role;
  return isRead(m) ? "auditor" : "admin";
}
