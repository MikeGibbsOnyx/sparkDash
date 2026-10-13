// Onyx Gateway: read the provider's own token counts out of a response, per API format.
//
// Every format is normalised to { in, out, cacheRead, cacheWrite }, where `in` never includes
// cached tokens (OpenAI and Gemini report cached tokens inside the prompt count; Anthropic
// reports them separately), and `out` includes reasoning and thinking tokens, which are billed
// as output. A field the provider didn't report is null.

/** @typedef {{ in: number | null, out: number | null, cacheRead: number | null, cacheWrite: number | null }} Usage */

const num = (v) => (Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
const sub = (a, b) => (a == null ? null : Math.max(0, a - (b ?? 0)));
const add = (a, b) => (a == null && b == null ? null : (a ?? 0) + (b ?? 0));

export const EMPTY_USAGE = Object.freeze({ in: null, out: null, cacheRead: null, cacheWrite: null });

/** Merge a later reading over an earlier one: fields the later one reports win. */
export function mergeUsage(a, b) {
  if (!b) return a;
  return {
    in: b.in ?? a.in,
    out: b.out ?? a.out,
    cacheRead: b.cacheRead ?? a.cacheRead,
    cacheWrite: b.cacheWrite ?? a.cacheWrite,
  };
}

export function hasUsage(u) {
  return Boolean(u) && (u.in != null || u.out != null || u.cacheRead != null || u.cacheWrite != null);
}

/** Anthropic `usage` (also the shape inside message_start and message_delta). */
function anthropicUsage(u) {
  if (!u || typeof u !== "object") return null;
  return { in: num(u.input_tokens), out: num(u.output_tokens), cacheRead: num(u.cache_read_input_tokens), cacheWrite: num(u.cache_creation_input_tokens) };
}

/** OpenAI Chat Completions and Completions `usage`; embeddings report only prompt tokens. */
function openaiChatUsage(u) {
  if (!u || typeof u !== "object") return null;
  const prompt = num(u.prompt_tokens);
  const cached = num(u.prompt_tokens_details?.cached_tokens);
  return { in: sub(prompt, cached), out: num(u.completion_tokens) ?? (prompt != null ? 0 : null), cacheRead: cached, cacheWrite: null };
}

/** OpenAI Responses `usage`. */
function openaiResponsesUsage(u) {
  if (!u || typeof u !== "object") return null;
  const input = num(u.input_tokens);
  const cached = num(u.input_tokens_details?.cached_tokens);
  return { in: sub(input, cached), out: num(u.output_tokens), cacheRead: cached, cacheWrite: null };
}

/** Gemini `usageMetadata`. Thoughts are billed as output; tool-use prompt tokens as input. */
function geminiUsage(u) {
  if (!u || typeof u !== "object") return null;
  const prompt = add(num(u.promptTokenCount), num(u.toolUsePromptTokenCount));
  const cached = num(u.cachedContentTokenCount);
  return { in: sub(prompt, cached), out: add(num(u.candidatesTokenCount), num(u.thoughtsTokenCount)), cacheRead: cached, cacheWrite: null };
}

/**
 * Usage from a complete (non-streaming) response body.
 * @param {string} format  from proxy/formats.js classify()
 * @param {unknown} body   parsed JSON
 * @returns {Usage | null}
 */
export function usageFromBody(format, body) {
  if (!body || typeof body !== "object") return null;
  switch (format) {
    case "anthropic":
      return anthropicUsage(body.usage);
    case "openai-chat":
    case "openai-completions":
    case "openai-embeddings":
      return openaiChatUsage(body.usage);
    case "openai-responses":
      return openaiResponsesUsage(body.usage ?? body.response?.usage);
    case "gemini": {
      // streamGenerateContent without alt=sse answers with a JSON array of chunks.
      if (Array.isArray(body)) {
        for (let i = body.length - 1; i >= 0; i--) if (body[i]?.usageMetadata) return geminiUsage(body[i].usageMetadata);
        return null;
      }
      return geminiUsage(body.usageMetadata);
    }
    default:
      return null;
  }
}

/** A cheap check before parsing an SSE event's JSON: only events that can carry usage are parsed. */
const MAY_CARRY = {
  anthropic: (event, data) => event === "message_start" || event === "message_delta" || /"type"\s*:\s*"message_(start|delta)"/.test(data),
  "openai-chat": (_e, data) => /"usage"\s*:\s*\{/.test(data),
  "openai-completions": (_e, data) => /"usage"\s*:\s*\{/.test(data),
  "openai-responses": (event, data) => /^response\.(completed|incomplete|failed)$/.test(event) || /"type"\s*:\s*"response\.(completed|incomplete|failed)"/.test(data),
  gemini: (_e, data) => data.includes("usageMetadata"),
};

/**
 * Usage carried by one SSE event, or null.
 * @param {string} format
 * @param {string} event  the `event:` field ("" when absent)
 * @param {string} data   the joined `data:` lines
 * @returns {Usage | null}
 */
export function usageFromEvent(format, event, data) {
  const may = MAY_CARRY[format];
  if (!may || !data || !may(event, data)) return null;
  let obj;
  try {
    obj = JSON.parse(data);
  } catch {
    return null;
  }
  switch (format) {
    case "anthropic":
      if (obj.type === "message_start") return anthropicUsage(obj.message?.usage);
      if (obj.type === "message_delta") return anthropicUsage(obj.usage);
      return null;
    case "openai-chat":
    case "openai-completions":
      return openaiChatUsage(obj.usage);
    case "openai-responses":
      return openaiResponsesUsage(obj.response?.usage);
    case "gemini":
      return geminiUsage(obj.usageMetadata);
    default:
      return null;
  }
}

/** Which formats and endpoints are metered. Token-counting endpoints cost nothing. */
export function isMetered(format, pathname) {
  if (/count_tokens$|:countTokens$|^\/v1\/responses\/input_tokens$/.test(pathname)) return false;
  return Boolean(MAY_CARRY[format]) || format === "openai-embeddings";
}
