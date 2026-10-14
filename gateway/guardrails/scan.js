// Onyx Gateway: find the text in a request that guardrails look at, per API format, and change it
// in place. Scanned: message and system text, and tool results. Never touched: thinking blocks
// and their signatures, encrypted reasoning, base64 media, IDs, model names, tool schemas and
// tool-call arguments, and any Gemini part that carries a thought signature (the provider rejects
// a replayed function call whose signature or content changed).

/**
 * A place in the body that holds scannable text.
 * @typedef {{ get: () => string, set: (s: string) => void, where: string }} Slot
 */

function strSlot(obj, key, where) {
  return typeof obj?.[key] === "string" ? [{ get: () => obj[key], set: (s) => (obj[key] = s), where }] : [];
}

/** Every string leaf of a JSON value (tool results can be structured). */
function leafSlots(obj, where, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 20) return [];
  const out = [];
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (typeof v === "string") out.push({ get: () => obj[k], set: (s) => (obj[k] = s), where });
    else if (v && typeof v === "object") out.push(...leafSlots(v, where, depth + 1));
  }
  return out;
}

// ─── Anthropic Messages ─────────────────────────────────
function anthropicBlocks(blocks, where) {
  const out = [];
  if (!Array.isArray(blocks)) return out;
  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text") out.push(...strSlot(b, "text", where));
    else if (b.type === "tool_result") {
      if (typeof b.content === "string") out.push(...strSlot(b, "content", "tool result"));
      else out.push(...anthropicBlocks(b.content, "tool result"));
    }
    // thinking, redacted_thinking, tool_use, image, document, search results: untouched.
  }
  return out;
}

function anthropicSlots(body) {
  const out = [];
  if (typeof body.system === "string") out.push(...strSlot(body, "system", "system"));
  else out.push(...anthropicBlocks(body.system, "system"));
  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    if (typeof m?.content === "string") out.push(...strSlot(m, "content", m.role || "message"));
    else out.push(...anthropicBlocks(m?.content, m?.role || "message"));
  }
  return out;
}

// ─── OpenAI Chat Completions ────────────────────────────
function chatSlots(body) {
  const out = [];
  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    if (!m || typeof m !== "object") continue;
    const where = m.role === "tool" || m.role === "function" ? "tool result" : m.role || "message";
    if (typeof m.content === "string") out.push(...strSlot(m, "content", where));
    else if (Array.isArray(m.content)) for (const p of m.content) if (p?.type === "text") out.push(...strSlot(p, "text", where));
  }
  return out;
}

// ─── OpenAI Responses ───────────────────────────────────
function responsesSlots(body) {
  const out = [...strSlot(body, "instructions", "system")];
  if (typeof body.input === "string") out.push(...strSlot(body, "input", "user"));
  for (const it of Array.isArray(body.input) ? body.input : []) {
    if (!it || typeof it !== "object") continue;
    if (it.type === "function_call_output" || it.type === "custom_tool_call_output") {
      if (typeof it.output === "string") out.push(...strSlot(it, "output", "tool result"));
      else if (Array.isArray(it.output)) for (const p of it.output) if (typeof p?.text === "string") out.push(...strSlot(p, "text", "tool result"));
      continue;
    }
    if (it.type && it.type !== "message") continue; // reasoning (encrypted), function_call, …: untouched
    if (typeof it.content === "string") out.push(...strSlot(it, "content", it.role || "message"));
    else if (Array.isArray(it.content)) {
      for (const p of it.content) if (p && (p.type === "input_text" || p.type === "output_text" || p.type === "text")) out.push(...strSlot(p, "text", it.role || "message"));
    }
  }
  return out;
}

// ─── Completions and Embeddings ─────────────────────────
function promptSlots(body, key) {
  const v = body[key];
  if (typeof v === "string") return strSlot(body, key, "user");
  if (Array.isArray(v)) return v.flatMap((x, i) => (typeof x === "string" ? [{ get: () => v[i], set: (s) => (v[i] = s), where: "user" }] : []));
  return [];
}

// ─── Gemini ─────────────────────────────────────────────
function geminiParts(parts, where) {
  const out = [];
  for (const p of Array.isArray(parts) ? parts : []) {
    if (!p || typeof p !== "object") continue;
    if (p.thought === true || p.thoughtSignature || p.thought_signature) continue;
    if (typeof p.text === "string") out.push(...strSlot(p, "text", where));
    else if (p.functionResponse?.response) out.push(...leafSlots(p.functionResponse.response, "tool result"));
  }
  return out;
}

function geminiSlots(body) {
  const out = [];
  const sys = body.systemInstruction || body.system_instruction;
  if (sys) out.push(...geminiParts(sys.parts, "system"));
  for (const c of Array.isArray(body.contents) ? body.contents : []) out.push(...geminiParts(c?.parts, c?.role || "user"));
  return out;
}

/** The scannable text of a request body, in conversation order. */
export function textSlots(format, body) {
  if (!body || typeof body !== "object") return [];
  switch (format) {
    case "anthropic":
      return anthropicSlots(body);
    case "openai-chat":
      return chatSlots(body);
    case "openai-responses":
      return responsesSlots(body);
    case "openai-completions":
      return promptSlots(body, "prompt");
    case "openai-embeddings":
      return promptSlots(body, "input");
    case "gemini":
      return geminiSlots(body);
    default:
      return [];
  }
}

// ─── Tool blocking ──────────────────────────────────────
function toolName(format, t) {
  if (!t || typeof t !== "object") return null;
  if (format === "openai-chat") return t.function?.name ?? t.name ?? null;
  return t.name ?? null;
}

/**
 * Remove tools whose names match a pattern from the request. A tool choice that names a removed
 * tool is dropped too (the provider would reject it). Returns the removed names.
 * @param {(name: string) => boolean} blocked
 */
export function removeTools(format, body, blocked) {
  const removed = [];
  if (!body || typeof body !== "object") return removed;
  const filter = (arr, nameOf) =>
    arr.filter((t) => {
      const n = nameOf(t);
      if (n && blocked(n)) {
        removed.push(n);
        return false;
      }
      return true;
    });
  if (format === "gemini") {
    if (Array.isArray(body.tools)) {
      for (const t of body.tools) {
        for (const key of ["functionDeclarations", "function_declarations"]) {
          if (Array.isArray(t?.[key])) t[key] = filter(t[key], (d) => d?.name ?? null);
        }
      }
      body.tools = body.tools.filter((t) => !(t && Object.keys(t).length === 1 && Array.isArray(t.functionDeclarations ?? t.function_declarations) && (t.functionDeclarations ?? t.function_declarations).length === 0));
      if (!body.tools.length) delete body.tools;
    }
    return removed;
  }
  if (Array.isArray(body.tools)) {
    body.tools = filter(body.tools, (t) => toolName(format, t));
    if (!body.tools.length) delete body.tools;
  }
  if (format === "openai-chat" && Array.isArray(body.functions)) {
    body.functions = filter(body.functions, (f) => f?.name ?? null);
    if (!body.functions.length) delete body.functions;
  }
  if (removed.length && body.tool_choice && typeof body.tool_choice === "object") {
    const named = body.tool_choice.name ?? body.tool_choice.function?.name;
    if (named && removed.includes(named)) delete body.tool_choice;
  }
  if (removed.length && !body.tools && body.tool_choice) delete body.tool_choice;
  return removed;
}
