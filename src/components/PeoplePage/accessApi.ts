// Onyx: dashboard API for identity, People, groups and access settings.
import { authHeaders, reportAuthRequired } from "../../api/authToken";

export type Role = "member" | "auditor" | "admin" | "owner";

export const ROLE_LABELS: Record<Role, string> = { member: "Member", auditor: "Auditor", admin: "Admin", owner: "Owner" };
const RANK: Role[] = ["member", "auditor", "admin", "owner"];

export function atLeast(role: Role | null | undefined, min: Role): boolean {
  return role != null && RANK.indexOf(role) >= RANK.indexOf(min);
}

export type Me =
  | {
      signedIn: true;
      via: "serve" | "whois" | "local" | "token" | "key";
      login: string | null;
      name: string | null;
      device: string | null;
      role: Role | null;
      roleLabel: string | null;
      tagged: boolean;
      canClaim: boolean;
    }
  | { signedIn: false; error: string; fix: string };

export type Person = {
  login: string;
  displayName: string | null;
  role: Role;
  firstSeen: number;
  lastSeen: number;
  lastDevice: string | null;
  groups: string[];
};

export type Group = { id: number; name: string; members: string[] };

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...authHeaders() };
  if (init?.body) headers["Content-Type"] = "application/json";
  const res = await fetch(path, { ...init, headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) reportAuthRequired();
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return body as T;
}

export const fetchMe = () => call<Me>("/api/access/me");
export const redeemClaimCode = (code: string) => call<{ ok: true; role: Role }>("/api/access/claim", { method: "POST", body: JSON.stringify({ code }) });
export const fetchPeople = () => call<{ people: Person[]; groups: Group[] }>("/api/access/people");
export const setPersonRole = (login: string, role: Role) =>
  call<{ person: Person }>(`/api/access/people/${encodeURIComponent(login)}/role`, { method: "PUT", body: JSON.stringify({ role }) });
export const removePerson = (login: string) => call<{ ok: true }>(`/api/access/people/${encodeURIComponent(login)}`, { method: "DELETE" });
export const saveGroup = (group: { id?: number; name: string; members: string[] }) =>
  call<{ group: Group }>(group.id ? `/api/access/groups/${group.id}` : "/api/access/groups", {
    method: group.id ? "PUT" : "POST",
    body: JSON.stringify({ name: group.name, members: group.members }),
  });
export const deleteGroup = (id: number) => call<{ ok: true }>(`/api/access/groups/${id}`, { method: "DELETE" });
export const fetchAccessSettings = () => call<{ defaultRole: Role }>("/api/access/settings");
export const saveAccessSettings = (s: { defaultRole: Role }) => call<{ defaultRole: Role }>("/api/access/settings", { method: "PUT", body: JSON.stringify(s) });
export const createClaimCode = () => call<{ code: string; expiresAt: number }>("/api/access/claim-codes", { method: "POST" });
