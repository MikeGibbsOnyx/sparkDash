// Onyx Gateway: the one body change the Gateway makes. A streamed Chat Completions request whose
// client didn't ask for usage gets `stream_options.include_usage: true`, so the provider reports
// token counts; the extra usage-only chunk that produces is removed before the client sees it.
// A provider's "Report usage on streams" switch turns this off.

/**
 * The request body with include_usage turned on, or null when nothing needs changing.
 * When the body has no stream_options, the field is inserted as text after the opening brace, so
 * every other byte is unchanged; otherwise the body is re-serialised.
 * @param {Buffer} body
 * @param {any} parsed
 * @returns {Buffer | null}
 */
export function injectIncludeUsage(body, parsed) {
  if (!parsed || typeof parsed !== "object" || parsed.stream !== true) return null;
  if (parsed.stream_options?.include_usage === true) return null;
  if (parsed.stream_options === undefined) {
    const text = body.toString("utf8");
    const brace = text.indexOf("{");
    if (brace === -1) return null;
    const rest = text.slice(brace + 1).trimStart();
    const sep = rest.startsWith("}") ? "" : ",";
    return Buffer.from(`${text.slice(0, brace + 1)}"stream_options":{"include_usage":true}${sep}${text.slice(brace + 1)}`);
  }
  const so = parsed.stream_options && typeof parsed.stream_options === "object" ? parsed.stream_options : {};
  return Buffer.from(JSON.stringify({ ...parsed, stream_options: { ...so, include_usage: true } }));
}

/** The usage-only chunk include_usage adds: no choices, a usage object. */
function isUsageOnlyEvent(text) {
  if (!/"usage"\s*:\s*\{/.test(text) || !/"choices"\s*:\s*\[\s*\]/.test(text)) return false;
  const data = text
    .split(/\r\n|\r|\n/)
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).replace(/^ /, ""))
    .join("\n");
  try {
    const obj = JSON.parse(data);
    return Array.isArray(obj.choices) && obj.choices.length === 0 && obj.usage && typeof obj.usage === "object";
  } catch {
    return false;
  }
}

/** End of the next SSE event in buf from `from`: index just past its blank line, or -1. */
function eventEnd(buf, from) {
  for (let i = from; i < buf.length; i++) {
    const c = buf[i];
    if (c === 10) {
      if (buf[i + 1] === 10) return i + 2;
      if (buf[i + 1] === 13 && buf[i + 2] === 10) return i + 3;
    } else if (c === 13) {
      if (buf[i + 1] === 13) return i + 2;
      if (buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) return i + 4;
    }
  }
  return -1;
}

/**
 * Passes SSE events through whole and drops the usage-only one. Events are released as soon as
 * their terminating blank line arrives, so nothing waits on a later event.
 */
export function createUsageChunkFilter() {
  let pending = Buffer.alloc(0);
  let dropped = 0;
  return {
    /** @param {Buffer} chunk @returns {Buffer} what to send to the client now */
    push(chunk) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      const out = [];
      let start = 0;
      for (;;) {
        const end = eventEnd(pending, start);
        if (end === -1) break;
        const ev = pending.subarray(start, end);
        if (isUsageOnlyEvent(ev.toString("utf8"))) dropped++;
        else out.push(ev);
        start = end;
      }
      pending = pending.subarray(start);
      return out.length === 1 ? out[0] : Buffer.concat(out);
    },
    /** Whatever is left when the stream ends (an unterminated last event goes through as-is). */
    flush() {
      const rest = pending;
      pending = Buffer.alloc(0);
      return rest;
    },
    get dropped() {
      return dropped;
    },
  };
}
