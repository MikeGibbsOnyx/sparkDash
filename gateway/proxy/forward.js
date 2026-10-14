// Onyx Gateway: send one request upstream and stream the answer back, event by event.
// Nothing is buffered on the way back and an open stream has no idle timeout.
import { Agent, request } from "undici";
import { inboundHeaders } from "./headers.js";

export function createUpstreamAgent({ connectTimeoutMs, headersTimeoutMs }) {
  return new Agent({
    connect: { timeout: connectTimeoutMs, autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 2000 },
    headersTimeout: headersTimeoutMs,
    bodyTimeout: 0,
    keepAliveTimeout: 60_000,
    // undici's request() never follows redirects: a 3xx goes back to the client as-is,
    // so a provider key can't be carried to another host.
  });
}

/**
 * @param {object} p
 * @param {import("node:http").ServerResponse} p.res      client response
 * @param {import("node:http").IncomingMessage} p.req     client request (to notice a client hang-up)
 * @param {string} p.url
 * @param {Record<string, string>} p.headers
 * @param {Buffer} p.body
 * @param {Agent} p.agent
 * @param {(status: number, message: string) => void} p.onConnectError  writes a client-format error
 * @param {(status: number, headers: Record<string, unknown>) => ({ push: (b: Buffer) => void } | null)} [p.tap]
 *        given the upstream status and headers, returns a usage tap that reads a copy of the body
 * @param {{ push: (b: Buffer) => Buffer, flush: () => Buffer } | null} [p.filter]
 *        applied to a successful event stream on its way to the client (the include_usage chunk)
 * @returns {Promise<{ status: number | null, ttfbMs: number | null, latencyMs: number, error: string | null, partial: boolean, tap: object | null }>}
 */
export async function forward({ res, req, url, headers, body, agent, onConnectError, tap: makeTap, filter }) {
  const t0 = performance.now();
  const ac = new AbortController();
  const onClientGone = () => ac.abort();
  req.on("close", () => {
    if (!res.writableFinished) onClientGone();
  });

  let up;
  try {
    up = await request(url, { method: "POST", headers, body, dispatcher: agent, signal: ac.signal });
  } catch (err) {
    const code = err?.code || err?.cause?.code || err?.name || "error";
    if (ac.signal.aborted) return { status: null, ttfbMs: null, latencyMs: performance.now() - t0, error: "client closed", partial: false, tap: null };
    const timeout = /Timeout/i.test(code);
    onConnectError(timeout ? 504 : 502, timeout ? `The provider didn't answer in time (${code}).` : `The Gateway couldn't reach the provider (${code}).`);
    return { status: timeout ? 504 : 502, ttfbMs: null, latencyMs: performance.now() - t0, error: code, partial: false, tap: null };
  }
  let tap = null;
  try {
    tap = makeTap ? makeTap(up.statusCode, up.headers) : null;
  } catch {
    tap = null;
  }
  const sse = String(up.headers["content-type"] || "").includes("text/event-stream");
  const clientFilter = filter && up.statusCode < 300 && sse ? filter : null;

  const ttfbMs = performance.now() - t0;
  res.socket?.setNoDelay(true);
  res.writeHead(up.statusCode, inboundHeaders(up.headers));
  res.flushHeaders();

  return new Promise((resolve) => {
    let done = false;
    const finish = (error, partial) => {
      if (done) return;
      done = true;
      resolve({ status: up.statusCode, ttfbMs, latencyMs: performance.now() - t0, error, partial, tap });
    };
    const write = (buf) => {
      // Honour backpressure from a slow client.
      if (buf.length && !res.write(buf)) {
        up.body.pause();
        res.once("drain", () => up.body.resume());
      }
    };
    up.body.on("data", (chunk) => {
      // Write each chunk as it arrives, then let the tap read its copy.
      write(clientFilter ? clientFilter.push(chunk) : chunk);
      if (tap) {
        try {
          tap.push(chunk);
        } catch {
          tap = null;
        }
      }
    });
    up.body.on("end", () => {
      if (clientFilter) write(clientFilter.flush());
      res.end();
      finish(null, false);
    });
    up.body.on("error", (err) => {
      // Mid-stream drop: end the client's stream the same way (abruptly) so it sees the failure.
      const code = ac.signal.aborted ? "client closed" : err?.code || err?.message || "upstream error";
      res.destroy();
      finish(code, true);
    });
    res.on("close", () => {
      if (!up.body.destroyed && !res.writableFinished) up.body.destroy();
      finish(res.writableFinished ? null : "client closed", !res.writableFinished);
    });
  });
}
