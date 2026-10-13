// Onyx Gateway: the provider types the Gateway speaks to, and how to test a key for each.
import { redact } from "../../shared/redact.js";

export const OPENAI_FORMATS = ["openai-chat", "openai-responses", "openai-completions", "openai-embeddings"];

export const PROVIDER_TYPES = {
  anthropic: {
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    formats: ["anthropic"],
    auth: (key) => ({ "x-api-key": key }),
    ownLoginCapable: true,
    async listModels(base, key, f) {
      const r = await f(`${base}/v1/models?limit=1000`, { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } });
      return { res: r, models: (await jsonOrEmpty(r)).data?.map((m) => m.id) };
    },
  },
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com",
    formats: OPENAI_FORMATS,
    auth: (key) => ({ authorization: `Bearer ${key}` }),
    ownLoginCapable: true,
    async listModels(base, key, f) {
      const r = await f(`${base}/v1/models`, { headers: { authorization: `Bearer ${key}` } });
      return { res: r, models: (await jsonOrEmpty(r)).data?.map((m) => m.id) };
    },
  },
  openrouter: {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api",
    formats: OPENAI_FORMATS,
    auth: (key) => ({ authorization: `Bearer ${key}` }),
    ownLoginCapable: false,
    async listModels(base, key, f) {
      // /models is public; /key is what proves the key works.
      const check = await f(`${base}/v1/key`, { headers: { authorization: `Bearer ${key}` } });
      if (!check.ok) return { res: check, models: undefined };
      const r = await f(`${base}/v1/models`, { headers: { authorization: `Bearer ${key}` } });
      return { res: r, models: (await jsonOrEmpty(r)).data?.map((m) => m.id) };
    },
  },
  gemini: {
    label: "Gemini",
    baseUrl: "https://generativelanguage.googleapis.com",
    formats: ["gemini"],
    auth: (key) => ({ "x-goog-api-key": key }),
    ownLoginCapable: false,
    async listModels(base, key, f) {
      const r = await f(`${base}/v1beta/models?pageSize=1000`, { headers: { "x-goog-api-key": key } });
      return { res: r, models: (await jsonOrEmpty(r)).models?.map((m) => String(m.name).replace(/^models\//, "")) };
    },
  },
  local: {
    label: "Local server",
    baseUrl: "",
    formats: OPENAI_FORMATS,
    auth: (key) => (key ? { authorization: `Bearer ${key}` } : {}),
    ownLoginCapable: false,
    async listModels(base, key, f) {
      const r = await f(`${base}/v1/models`, { headers: key ? { authorization: `Bearer ${key}` } : {} });
      return { res: r, models: (await jsonOrEmpty(r)).data?.map((m) => m.id) };
    },
  },
};

async function jsonOrEmpty(res) {
  try {
    return await res.clone().json();
  } catch {
    return {};
  }
}

/** The prefix picks the provider; anything else opens the picker. */
export function detectProvider(key) {
  const k = String(key || "").trim();
  if (k.startsWith("sk-ant-")) return "anthropic";
  if (k.startsWith("sk-or-")) return "openrouter";
  if (k.startsWith("AIza")) return "gemini";
  if (k.startsWith("sk-")) return "openai";
  return null;
}

/**
 * Test a key with the provider's free model-list call.
 * @returns {Promise<{ ok: boolean, models: string[], message: string, status?: number, details?: string }>}
 */
export async function testKey(type, key, { baseUrl, fetchImpl = fetch } = {}) {
  const def = PROVIDER_TYPES[type];
  if (!def) return { ok: false, models: [], message: `Unknown provider type "${type}".` };
  const base = (baseUrl || def.baseUrl).replace(/\/+$/, "");
  const f = (url, init) => fetchImpl(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(15_000) });
  let res;
  let models;
  try {
    ({ res, models } = await def.listModels(base, key, f));
  } catch (err) {
    return {
      ok: false,
      models: [],
      message: `Couldn't reach ${def.label}. Check this machine's network and DNS, then try again.`,
      details: redact(err?.cause?.code || err?.message || String(err), [key]),
    };
  }
  if (res.ok && Array.isArray(models)) {
    return { ok: true, models, status: res.status, message: `Works. ${models.length} model${models.length === 1 ? "" : "s"} available.` };
  }
  const body = redact(await res.text().catch(() => ""), [key]).slice(0, 500);
  const name = def.label;
  const message =
    res.status >= 300 && res.status < 400
      ? `${name} redirected the request (${res.status}); the Gateway doesn't follow redirects with a key. Check the base URL.`
      : [400, 401, 403].includes(res.status)
        ? `${name} rejected this key (${res.status}). Copy the whole key and paste it again.`
        : res.status === 429
          ? `${name} is rate-limiting this key (429). Wait a minute and try again.`
          : res.ok
            ? `${name} answered, but not with a model list. Check the base URL.`
            : `${name} answered ${res.status}. Try again; if it repeats, check the provider's status page.`;
  return { ok: false, models: [], status: res.status, message, details: body };
}
