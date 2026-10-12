// Onyx: dashboard API for the AI Gateway (Observer -> Gateway over the internal socket).
import { authHeaders, reportAuthRequired } from "../../api/authToken";

export type Finding = { id: string; severity: "info" | "warn" | "error"; title: string; detail: string; hint: string };

export type GatewayHealth =
  | {
      up: true;
      enabled: boolean;
      version: string;
      bind: string;
      providers: number;
      localServed: number;
      models: number;
      today: { requests: number; people: number; errors: number; topPeople: { identity: string; requests: number }[]; topModels: { model: string; requests: number }[] };
      findings: Finding[];
      personalKeys: boolean;
    }
  | { up: false; error: string };

export type PublishState = { published: boolean; url?: string; funnel: boolean; conflict?: string; unknown?: boolean; error?: string; command: string };
export type GatewayStatus = { gateway: GatewayHealth; publish: PublishState; port: number };

export type Provider = {
  id: string;
  type: "anthropic" | "openai" | "gemini" | "openrouter" | "local";
  typeLabel: string;
  name: string;
  keyLast4: string | null;
  keySource: "saved" | "env" | "local";
  addedBy: string | null;
  addedAt: number;
  lastUsedAt: number | null;
  status: "Working" | "Failing" | "Not tested" | "Unused 30 days";
  lastError: string | null;
  lastTestedAt: number | null;
  ownLogin: boolean;
  ownLoginCapable: boolean;
  enabled: boolean;
  modelCount: number;
  modelsEnabled: number;
};
export type SaveResult = { saved?: boolean; replaced?: boolean; ok: boolean | null; message: string; details?: string; provider?: Provider };
export type Model = { id: number; name: string; providerId: string; providerName: string; providerType: string; enabled: boolean; usable: boolean };
export type LocalServer = { id: string; machine: string; address: string; port: number; backend: string | null; models: string[]; hasApiKey: boolean; reachable: boolean; up: boolean; serve: boolean; fix: string | null };
export type GatewayKey = { id: number; name: string; prefix: string; actsAs: string | null; access: string | null; createdBy: string; createdAt: number; expiresAt: number | null; lastUsedAt: number | null; lastUsedFrom: string | null; revokedAt: number | null; state: "active" | "expiring" | "expired" | "revoked" };
export type Grant = { id: number; name: string; selectors: string[]; modelPatterns: string[]; mcpPatterns: string[]; updatedBy: string | null; updatedAt: number };

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
const admin = <T,>(path: string, method = "GET", body?: unknown) =>
  call<T>(`/api/gateway/admin${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });

export const fetchGatewayStatus = () => call<GatewayStatus>("/api/gateway/status");
export const publishGateway = () => call<PublishState & { ok: boolean }>("/api/gateway/publish", { method: "POST" });
export const enableGateway = () => admin("/enable", "POST");
export const pauseGateway = () => admin("/pause", "POST");
export const fetchProviders = () => admin<{ providers: Provider[]; conflicts: { name: string; providers: string }[] }>("/providers");
export const addProvider = (b: { key: string; type?: string | null; saveAnyway?: boolean; skipTest?: boolean }) => admin<SaveResult>("/providers", "POST", b);
export const retestProvider = (id: string) => admin<SaveResult>(`/providers/${id}/test`, "POST");
export const replaceProviderKey = (id: string, key: string) => admin<SaveResult>(`/providers/${id}/key`, "PUT", { key });
export const updateProvider = (id: string, b: { ownLogin?: boolean; enabled?: boolean }) => admin<{ provider: Provider }>(`/providers/${id}`, "PATCH", b);
export const providerImpact = (id: string) => admin<{ people: number; requests: number; modelsUsed: number; modelsServed: number }>(`/providers/${id}/impact`);
export const removeProvider = (id: string) => admin(`/providers/${id}`, "DELETE");
export const fetchModels = () => admin<{ models: Model[]; conflicts: { name: string; providers: string }[] }>("/models");
export const setModelEnabled = (id: number, enabled: boolean) => admin(`/models/${id}`, "PATCH", { enabled });
export const fetchLocalServers = () => admin<{ servers: LocalServer[] }>("/local-servers");
export const setServe = (id: string, serve: boolean) => admin<{ server: LocalServer }>(`/local-servers/${encodeURIComponent(id)}`, "PATCH", { serve });
export const fetchKeys = () => admin<{ keys: GatewayKey[] }>("/keys");
export const createKey = (b: { name: string; access: string | null; expiry: string }) => admin<{ key: string; record: GatewayKey }>("/keys", "POST", b);
export const revokeKey = (id: number) => admin(`/keys/${id}`, "DELETE");
export const fetchGrants = () => admin<{ grants: Grant[] }>("/grants");
export const fetchGatewaySettings = () => admin<{ personalKeys: boolean }>("/settings");
export const saveGatewaySettings = (b: { personalKeys: boolean }) => admin<{ personalKeys: boolean }>("/settings", "PATCH", b);

/** Same prefixes as the Gateway uses. */
export function detectProvider(key: string): Provider["type"] | null {
  const k = key.trim();
  if (k.startsWith("sk-ant-")) return "anthropic";
  if (k.startsWith("sk-or-")) return "openrouter";
  if (k.startsWith("AIza")) return "gemini";
  if (k.startsWith("sk-")) return "openai";
  return null;
}

export const PROVIDER_LABELS: Record<string, string> = { anthropic: "Anthropic", openai: "OpenAI", gemini: "Gemini", openrouter: "OpenRouter", local: "Local server" };

export function gatewayUrl(s: GatewayStatus | null): string {
  return s?.publish.url || `http://127.0.0.1:${s?.port ?? 5556}`;
}
