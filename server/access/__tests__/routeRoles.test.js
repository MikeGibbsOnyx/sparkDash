// Role matrix: every route declared anywhere in server/ has a minimum role, Members reach
// no fleet route, Auditors read but change nothing, and Admins do everything but Owner-only steps.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { minRoleFor } from "../routeRoles.js";
import { atLeast } from "../roles.js";

const SERVER = path.resolve(import.meta.dirname, "../..");

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "__tests__" || e.name === "node_modules" ? [] : sourceFiles(full);
    return e.name.endsWith(".js") ? [full] : [];
  });
}

/** Every `app.<method>("…")` / template-literal route, with ${…} and :params made concrete. */
function declaredRoutes() {
  const routes = [];
  for (const file of sourceFiles(SERVER)) {
    const src = fs.readFileSync(file, "utf8");
    const base = /const base = ["`]([^"`]+)["`]/.exec(src)?.[1];
    for (const m of src.matchAll(/\bapp\.(get|post|put|patch|delete)\(\s*(["`])([^"`]+)\2/g)) {
      let p = m[3].replace(/\$\{base\}/g, base || "").replace(/\$\{[^}]+\}/g, "x").replace(/:[A-Za-z]+/g, "x");
      if (p === "*splat") p = "/some/page";
      routes.push({ method: m[1].toUpperCase(), path: p, file: path.relative(SERVER, file) });
    }
  }
  return routes;
}

const ROUTES = declaredRoutes();
const PUBLIC = new Set(["GET /api/auth/status", "GET /api/access/me", "POST /api/access/claim", "GET /some/page"]);
const OWNER_ONLY = new Set(["POST /api/access/claim-codes"]);

test("the route scan finds the dashboard's routes", () => {
  assert.ok(ROUTES.length >= 90, `found only ${ROUTES.length}`);
  for (const must of ["POST /api/sparks", "DELETE /api/events", "GET /metrics", "POST /api/sparks/x/tool-eval/runs", "PUT /api/access/people/x/role"]) {
    assert.ok(ROUTES.some((r) => `${r.method} ${r.path}` === must), `missing ${must}`);
  }
});

test("every route has the expected minimum role", () => {
  for (const r of ROUTES) {
    const key = `${r.method} ${r.path}`;
    const expected = PUBLIC.has(key) ? null : OWNER_ONLY.has(key) ? "owner" : r.method === "GET" ? "auditor" : "admin";
    assert.equal(minRoleFor(r.method, r.path), expected, `${key} (${r.file})`);
  }
});

test("role matrix: what each role may do on every route", () => {
  for (const r of ROUTES) {
    const min = minRoleFor(r.method, r.path);
    const key = `${r.method} ${r.path}`;
    if (min === null) continue;
    assert.equal(atLeast("member", min), false, `Member must not reach ${key}`);
    assert.equal(atLeast("auditor", min), r.method === "GET", `Auditor on ${key}`);
    assert.equal(atLeast("admin", min), !OWNER_ONLY.has(key), `Admin on ${key}`);
    assert.equal(atLeast("owner", min), true, `Owner on ${key}`);
  }
});

test("the WebSocket, HEAD and unknown future routes default safely", () => {
  assert.equal(minRoleFor("GET", "/ws"), "auditor");
  assert.equal(minRoleFor("HEAD", "/api/sparks"), "auditor");
  assert.equal(minRoleFor("HEAD", "/api/access/me"), null);
  assert.equal(minRoleFor("POST", "/api/some-new-route"), "admin");
  assert.equal(minRoleFor("OPTIONS", "/api/sparks"), "admin");
  assert.equal(minRoleFor("GET", "/assets/index-abc.js"), null);
});
