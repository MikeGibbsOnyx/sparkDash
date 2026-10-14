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
      today: { requests: number; people: number; errors: number; topPeople: { identity: string; requests: number }[]; topModels: { model: string; requests: number }[]; cloudUsd: number; localUsd: number; tokens: number };
      timeZone: string;
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
  injectUsage: boolean;
  modelCount: number;
  modelsEnabled: number;
};
export type SaveResult = { saved?: boolean; replaced?: boolean; ok: boolean | null; message: string; details?: string; provider?: Provider };
export type Prices = { in: number | null; out: number | null; cacheRead: number | null; cacheWrite: number | null };
export type Model = { id: number; name: string; providerId: string; providerName: string; providerType: string; enabled: boolean; usable: boolean; prices: Prices; needsPrice: boolean };
export type LocalServer = { id: string; machine: string; address: string; port: number; backend: string | null; models: string[]; hasApiKey: boolean; reachable: boolean; up: boolean; serve: boolean; injectUsage: boolean; fix: string | null };
export type GatewayKey = { id: number; name: string; prefix: string; actsAs: string | null; access: string | null; createdBy: string; createdAt: number; expiresAt: number | null; lastUsedAt: number | null; lastUsedFrom: string | null; revokedAt: number | null; state: "active" | "expiring" | "expired" | "revoked" };
export type Grant = { id: number; name: string; selectors: string[]; modelPatterns: string[]; mcpPatterns: string[]; updatedBy: string | null; updatedAt: number };
export type GrantDraft = { name: string; selectors: string[]; modelPatterns: string[]; mcpPatterns?: string[] };
export type GrantPreview = { changes: { caller: string; gains: string[]; losses: string[] }[] };
export type Period = "day" | "week" | "month";
export type Budget = {
  id: number;
  name: string;
  scope: string;
  period: Period;
  limitUsd: number | null;
  limitTokens: number | null;
  warnPct: number;
  spentUsd: number;
  spentTokens: number;
  inFlightUsd: number;
  periodStart: number;
  resetsAt: number;
  resets: string;
  state: "ok" | "warning" | "exhausted";
  updatedBy: string | null;
  updatedAt: number;
};
export type BudgetDraft = { name: string; scope: string; period: Period; limitUsd: number | null; limitTokens: number | null; warnPct: number };
export type UsageRange = "24h" | "7d" | "30d" | "all";
export type GroupBy = "person" | "group" | "model" | "provider" | "client" | "session";
export type UsageRow = {
  key: string | null;
  requests: number;
  inTok: number;
  outTok: number;
  cacheReadTok: number;
  cacheWriteTok: number;
  cloudUsd: number;
  localUsd: number;
  subscriptionRequests: number;
  unpricedRequests: number;
  localPending: number;
  partialRequests: number;
  lastTs: number;
};
export type EnergySummary = {
  wh: number;
  costUsd: number;
  attributedUsd: number;
  unattributedUsd: number;
  minutesWithoutRate: number;
  pendingMinutes: number;
  lastMinute: number | null;
  rate: number | null;
  byMachine: { machine: string; wh: number; costUsd: number; attributedUsd: number; unattributedUsd: number; serverTokens: number; gatewayTokens: number }[];
};

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
export const updateProvider = (id: string, b: { ownLogin?: boolean; enabled?: boolean; injectUsage?: boolean }) => admin<{ provider: Provider }>(`/providers/${id}`, "PATCH", b);
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
export const setModelPrices = (id: number, p: Partial<Prices>) => admin<{ model: Model }>(`/models/${id}/prices`, "PATCH", p);
export const createGrant = (g: GrantDraft) => admin<{ grant: Grant }>("/grants", "POST", g);
export const updateGrant = (id: number, g: GrantDraft) => admin<{ grant: Grant }>(`/grants/${id}`, "PATCH", g);
export const removeGrant = (id: number) => admin(`/grants/${id}`, "DELETE");
export const previewGrant = (b: { id?: number | null; draft: GrantDraft | null }) => admin<GrantPreview>("/grants/preview", "POST", b);
export const fetchBudgets = () => admin<{ budgets: Budget[]; timeZone: string }>("/budgets");
export const createBudget = (b: BudgetDraft) => admin<{ budget: Budget }>("/budgets", "POST", b);
export const updateBudget = (id: number, b: Partial<BudgetDraft>) => admin<{ budget: Budget }>(`/budgets/${id}`, "PATCH", b);
export const removeBudget = (id: number) => admin(`/budgets/${id}`, "DELETE");
export const fetchUsage = (range: UsageRange, groupBy: GroupBy) => admin<{ range: UsageRange; groupBy: GroupBy; since: number; rows: UsageRow[] }>(`/usage?range=${range}&groupBy=${groupBy}`);
export const fetchUsageDaily = (range: UsageRange) => admin<{ timeZone: string; rows: { day: string; requests: number; tokens: number; cloudUsd: number; localUsd: number }[] }>(`/usage/daily?range=${range}`);
export const fetchEnergy = (range: UsageRange) => admin<EnergySummary>(`/usage/energy?range=${range}`);
export const fetchLocalUsage = (sinceMs: number) =>
  admin<{ models: { model: string; requests: number; people: number; promptTokens: number; completionTokens: number; energyUsd: number }[] }>(`/usage/local?since=${Math.max(0, Math.floor(sinceMs))}`);
export const fetchGatewaySettings = () => admin<{ personalKeys: boolean; timeZone?: string }>("/settings");
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

/** "$1.23", "$0.0042" for small amounts, "$0" for nothing. */
export function usd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "-";
  if (n === 0) return "$0";
  if (Math.abs(n) < 0.01) return `$${n.toPrecision(2)}`;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "1.2M", "34k", "512". */
export function tokens(n: number | null | undefined): string {
  const v = n ?? 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e4) return `${Math.round(v / 1e3)}k`;
  return v.toLocaleString("en-US");
}

// ─── Phase 4: request log, capture, guardrails ────────────
export type GuardrailHit = { detector: string; name: string; action: string; count: number; tools?: string[] };
export type RequestRow = {
  id: number;
  ts: number;
  identity: string;
  via: string;
  device: string | null;
  client: string | null;
  providerId: string | null;
  model: string | null;
  format: string | null;
  stream: boolean;
  status: number | null;
  latencyMs: number | null;
  ttfbMs: number | null;
  inTok: number | null;
  outTok: number | null;
  cacheReadTok: number | null;
  cacheWriteTok: number | null;
  costUsd: number | null;
  costBasis: string | null;
  partial: boolean;
  usageState: string | null;
  sessionId: string | null;
  agentId: string | null;
  guardrailHits: GuardrailHit[];
  error: string | null;
  headers: Record<string, string>;
  hasContent: boolean;
};
export type RequestFilter = { identity?: string; model?: string; status?: "" | "ok" | "error" | "blocked" | "refused" | "flagged"; range?: "" | "24h" | "7d" | "30d"; before?: number; limit?: number };
export type CapturedContent = { request: string | null; response: string | null; requestTruncated: boolean; responseTruncated: boolean };
export type DetectorMode = "off" | "flag" | "redact" | "block";
export type Detector = { id: string; name: string; builtin: boolean; mode: DetectorMode; pattern?: string; flags?: string };
export type GuardrailConfig = { detectors: Detector[]; blockedTools: string[]; hook: { url: string; failOpen: boolean; private: boolean } | null };
export type CaptureSettings = { mode: "metadata" | "full"; retention: { bodiesDays: number; metadataDays: number } };

export const fetchRequests = (f: RequestFilter) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== "" && v !== null) q.set(k, String(v));
  return admin<{ requests: RequestRow[]; more: boolean }>(`/requests?${q}`);
};
export const fetchRequestContent = (id: number) => admin<{ content: CapturedContent }>(`/requests/${id}/content`);
export const exportRequests = (from: number, to: number) => admin<{ jsonl: string; count: number }>(`/export?from=${from}&to=${to}`);
export const fetchPrivacy = () => admin<{ capture: CaptureSettings; guardrails: GuardrailConfig }>("/privacy");
export const saveCapture = (b: Partial<{ mode: CaptureSettings["mode"]; retention: Partial<CaptureSettings["retention"]> }>) => admin<{ capture: CaptureSettings }>("/privacy/capture", "PATCH", b);
export const setDetectorMode = (id: string, mode: DetectorMode) => admin<{ guardrails: GuardrailConfig }>(`/guardrails/detectors/${id}`, "PATCH", { mode });
export const addDetector = (b: { name: string; pattern: string; flags?: string; mode: DetectorMode }) => admin<{ guardrails: GuardrailConfig }>("/guardrails/detectors", "POST", b);
export const removeDetector = (id: string) => admin<{ guardrails: GuardrailConfig }>(`/guardrails/detectors/${id}`, "DELETE");
export const saveBlockedTools = (blockedTools: string[]) => admin<{ guardrails: GuardrailConfig }>("/guardrails/tools", "PUT", { blockedTools });
export const saveHook = (b: { url: string; failOpen: boolean } | null) => admin<{ guardrails: GuardrailConfig }>("/guardrails/hook", "PUT", b ?? {});
export const testDetectors = (text: string, pattern?: string, flags?: string) => admin<{ redacted: string; hits: GuardrailHit[] }>("/guardrails/test", "POST", { text, pattern, flags });

// ─── Phase 5: MCP servers ─────────────────────────────────
export type McpServer = {
  id: number;
  name: string;
  url: string;
  enabled: boolean;
  status: "Connected" | "Failing" | "Not tested";
  lastError: string | null;
  lastTestedAt: number | null;
  toolCount: number;
  tools: string[];
  headerName: string | null;
  headerLast4: string | null;
  addedBy: string | null;
  addedAt: number;
};
export type McpSaveResult = { saved?: boolean; replaced?: boolean; ok: boolean; message: string; details?: string; server?: McpServer };
export const fetchMcpServers = () => admin<{ servers: McpServer[] }>("/mcp-servers");
export const addMcpServer = (b: { name?: string; url: string; headerName?: string; headerValue?: string; saveAnyway?: boolean }) => admin<McpSaveResult>("/mcp-servers", "POST", b);
export const testMcpServer = (id: number) => admin<McpSaveResult>(`/mcp-servers/${id}/test`, "POST");
export const updateMcpServer = (id: number, b: { enabled?: boolean; headerName?: string; headerValue?: string }) => admin<McpSaveResult>(`/mcp-servers/${id}`, "PATCH", b);
export const removeMcpServer = (id: number) => admin(`/mcp-servers/${id}`, "DELETE");
