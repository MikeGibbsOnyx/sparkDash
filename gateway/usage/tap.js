// Onyx Gateway: the usage tap. It reads a copy of a response while the response streams to the
// client, and never holds the client up: chunks are written to the client first, then handed here.
// A compressed response is inflated on the copy only; what the client receives is unchanged.
import zlib from "node:zlib";
import { EMPTY_USAGE, hasUsage, mergeUsage, usageFromBody, usageFromEvent } from "./parse.js";

/** A non-streaming body larger than this isn't parsed (no provider sends usage in one that large). */
const MAX_BODY_BYTES = 64 * 1024 * 1024;
/** One SSE line longer than this (a huge base64 image, say) is skipped, not buffered. */
const MAX_LINE_BYTES = 16 * 1024 * 1024;

function decoderFor(encoding) {
  const e = String(encoding || "").trim().toLowerCase();
  if (!e || e === "identity") return { ok: true, stream: null };
  if (e === "gzip" || e === "x-gzip") return { ok: true, stream: zlib.createGunzip() };
  if (e === "deflate") return { ok: true, stream: zlib.createInflate() };
  if (e === "br") return { ok: true, stream: zlib.createBrotliDecompress() };
  if (e === "zstd" && typeof zlib.createZstdDecompress === "function") return { ok: true, stream: zlib.createZstdDecompress() };
  return { ok: false, stream: null };
}

/**
 * Incremental SSE reader: splits lines (\n, \r\n or \r), groups `event:` and `data:` fields, and
 * calls onEvent(event, data) at each blank line.
 */
export function createSseReader(onEvent) {
  let carry = "";
  let skipping = false;
  let afterCR = false; // a chunk that ended in \r: a leading \n in the next one belongs to it
  let event = "";
  let data = [];
  const decoder = new TextDecoder();

  function line(l) {
    if (l === "") {
      if (data.length) onEvent(event, data.join("\n"));
      event = "";
      data = [];
      return;
    }
    if (l.startsWith(":")) return;
    const i = l.indexOf(":");
    const field = i === -1 ? l : l.slice(0, i);
    let value = i === -1 ? "" : l.slice(i + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }

  function text(s) {
    let start = 0;
    if (afterCR && s.charCodeAt(0) === 10) start = 1;
    afterCR = false;
    for (let i = start; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c !== 10 && c !== 13) continue;
      const piece = s.slice(start, i);
      if (skipping) skipping = false;
      else line(carry + piece);
      carry = "";
      if (c === 13 && i + 1 === s.length) afterCR = true;
      if (c === 13 && s.charCodeAt(i + 1) === 10) i++;
      start = i + 1;
    }
    const rest = s.slice(start);
    if (skipping) return;
    if (carry.length + rest.length > MAX_LINE_BYTES) {
      carry = "";
      skipping = true;
      return;
    }
    carry += rest;
  }

  return {
    push: (buf) => text(decoder.decode(buf, { stream: true })),
    end: () => {
      text(decoder.decode());
      if (carry && !skipping) line(carry);
      line("");
    },
  };
}

/**
 * @param {object} p
 * @param {string} p.format          from classify()
 * @param {Record<string, unknown>} p.headers  upstream response headers
 * @returns {{ push: (chunk: Buffer) => void, end: (complete: boolean) => Promise<{ usage: import("./parse.js").Usage, found: boolean, readable: boolean, partial: boolean }> }}
 */
export function createUsageTap({ format, headers }) {
  const type = String(headers?.["content-type"] || "").toLowerCase();
  const sse = type.includes("text/event-stream");
  const dec = decoderFor(headers?.["content-encoding"]);
  let usage = EMPTY_USAGE;
  let readable = dec.ok;
  let finished = Promise.resolve();

  let consume;
  let finishParse;
  if (sse) {
    const reader = createSseReader((event, data) => {
      const u = usageFromEvent(format, event, data);
      if (u) usage = mergeUsage(usage, u);
    });
    consume = (buf) => reader.push(buf);
    finishParse = () => reader.end();
  } else {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    consume = (buf) => {
      if (tooBig) return;
      size += buf.length;
      if (size > MAX_BODY_BYTES) {
        tooBig = true;
        chunks.length = 0;
        return;
      }
      chunks.push(buf);
    };
    finishParse = () => {
      if (tooBig || !chunks.length) return;
      try {
        const u = usageFromBody(format, JSON.parse(Buffer.concat(chunks).toString("utf8")));
        if (u) usage = mergeUsage(usage, u);
      } catch {
        /* not JSON (an HTML error page, say): no usage */
      }
    };
  }

  if (dec.stream) {
    const z = dec.stream;
    z.on("data", (b) => consume(b));
    finished = new Promise((resolve) => {
      z.on("end", resolve);
      z.on("error", () => {
        readable = false;
        resolve();
      });
    });
  }

  return {
    push(chunk) {
      if (!readable) return;
      if (dec.stream) dec.stream.write(chunk);
      else consume(chunk);
    },
    /** @param {boolean} complete  false when the stream ended early (client gone, upstream drop) */
    async end(complete) {
      if (dec.stream) {
        if (readable) dec.stream.end();
        else dec.stream.destroy();
        // A truncated compressed stream never emits "end"; don't wait for it.
        await (complete ? finished : Promise.race([finished, new Promise((r) => setTimeout(r, 50))]));
      }
      if (readable) {
        try {
          finishParse();
        } catch {
          /* never let a parser problem reach the request path */
        }
      }
      const found = hasUsage(usage);
      // Usage that didn't fully arrive is "partial": a stream cut short, or one whose final
      // usage report never came.
      const partial = !complete || (found && format === "anthropic" && sse && usage.out == null);
      return { usage, found, readable, partial };
    },
  };
}
