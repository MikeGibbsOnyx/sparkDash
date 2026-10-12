// Onyx Gateway: which endpoint speaks which API format, where the model name is, and how
// each format expects an error to look.

/**
 * @returns {{ format: string, family: "anthropic" | "openai" | "gemini", modelFrom: "body" | "path", model?: string, stream?: boolean } | null}
 */
export function classify(method, pathname) {
  if (method !== "POST") return null;
  if (pathname === "/v1/messages" || pathname === "/v1/messages/count_tokens") return { format: "anthropic", family: "anthropic", modelFrom: "body" };
  if (pathname === "/v1/chat/completions") return { format: "openai-chat", family: "openai", modelFrom: "body" };
  if (pathname === "/v1/responses" || pathname.startsWith("/v1/responses/")) return { format: "openai-responses", family: "openai", modelFrom: "body" };
  if (pathname === "/v1/completions") return { format: "openai-completions", family: "openai", modelFrom: "body" };
  if (pathname === "/v1/embeddings") return { format: "openai-embeddings", family: "openai", modelFrom: "body" };
  const g = /^\/v1beta\/models\/([^/:]+):([A-Za-z]+)$/.exec(pathname);
  if (g) return { format: "gemini", family: "gemini", modelFrom: "path", model: decodeURIComponent(g[1]), stream: g[2] === "streamGenerateContent" };
  return null;
}

/** The family a request expects errors in, guessed from its path and headers. */
export function familyFor(pathname, headers = {}) {
  if (pathname.startsWith("/v1beta/")) return "gemini";
  if (pathname.startsWith("/v1/messages") || headers["anthropic-version"]) return "anthropic";
  return "openai";
}

const ANTHROPIC_TYPES = { 400: "invalid_request_error", 401: "authentication_error", 403: "permission_error", 404: "not_found_error", 413: "request_too_large", 429: "rate_limit_error", 502: "api_error", 503: "overloaded_error" };
const GEMINI_STATUS = { 400: "INVALID_ARGUMENT", 401: "UNAUTHENTICATED", 403: "PERMISSION_DENIED", 404: "NOT_FOUND", 413: "INVALID_ARGUMENT", 429: "RESOURCE_EXHAUSTED", 502: "UNAVAILABLE", 503: "UNAVAILABLE" };
const OPENAI_TYPES = { 400: "invalid_request_error", 401: "authentication_error", 403: "permission_error", 404: "not_found_error", 413: "invalid_request_error", 429: "rate_limit_exceeded", 502: "server_error", 503: "server_error" };

/**
 * Write a Gateway error in the client's own format. Refusals carry `x-should-retry: false`,
 * so clients like Claude Code don't loop on them.
 */
export function sendError(res, family, status, message, extraHeaders = {}) {
  let body;
  if (family === "anthropic") body = { type: "error", error: { type: ANTHROPIC_TYPES[status] || "api_error", message } };
  else if (family === "gemini") body = { error: { code: status, message, status: GEMINI_STATUS[status] || "INTERNAL" } };
  else body = { error: { message, type: OPENAI_TYPES[status] || "server_error", code: OPENAI_TYPES[status] || null } };
  const retry = status === 502 || status === 503;
  res.writeHead(status, {
    "content-type": "application/json",
    "x-should-retry": retry ? "true" : "false",
    "x-sparkdash-gateway-error": "1",
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

/** Which tool is calling, for usage and the Connect page's live line. */
export function clientFromUserAgent(ua) {
  const s = String(ua || "");
  if (/claude-cli\//i.test(s)) return "Claude Code";
  if (/claude-desktop|Claude\/[\d.]+ .*Electron/i.test(s)) return "Claude Desktop";
  if (/codex_/i.test(s)) return "Codex";
  if (/GeminiCLI/i.test(s)) return "Gemini CLI";
  if (/opencode\//i.test(s)) return "OpenCode";
  if (/^curl\//i.test(s)) return "curl";
  const first = s.split(/[\s(]/)[0];
  return first ? first.slice(0, 40) : "Unknown";
}
