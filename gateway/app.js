// Onyx Gateway: the public listener: model APIs, /me, and the Connect page.
import fs from "node:fs";
import path from "node:path";
import { resolveIdentity } from "../shared/identity/index.js";
import { redact } from "../shared/redact.js";
import { isGatewayKey } from "./credentials/gatewayKeys.js";
import { PROVIDER_TYPES } from "./providers/catalog.js";
import { groupsFor } from "./policy/grants.js";
import { classify, clientFromUserAgent, familyFor, sendError } from "./proxy/formats.js";
import { outboundHeaders, presentedCredential } from "./proxy/headers.js";
import { forward } from "./proxy/forward.js";
import { createRateLimiter, crossOrigin } from "./security.js";

const STATIC_TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };

/**
 * @param {object} deps
 * @param {ReturnType<import("./config.js").loadConfig>} deps.config
 * @param {import("./store/state.js").State} deps.state
 * @param {import("./providers/registry.js").Providers} deps.providers
 * @param {import("./policy/grants.js").Grants} deps.grants
 * @param {import("./credentials/gatewayKeys.js").GatewayKeys} deps.keys
 * @param {(ip: string, port?: number) => Promise<object | null>} deps.whois
 * @param {import("undici").Agent} deps.agent
 * @param {(line: string) => void} [deps.log]
 */
export function createPublicHandler(deps) {
  const { config, state, providers, grants, keys, whois, agent } = deps;
  const log = deps.log || ((line) => console.log(line));
  const allow = createRateLimiter(config.ratePerMinute);

  /** Who is calling, as grants see them. */
  async function identify(req, url) {
    const creds = presentedCredential(req.headers, url.searchParams);
    const gw = creds.find((c) => c.value.startsWith("sdgw_"));
    const id = await resolveIdentity(req, {
      listenerLoopback: config.bindClass === "loopback",
      whois,
      gatewayKey: async () => {
        if (!gw) return null;
        const v = isGatewayKey(gw.value) ? keys.verify(gw.value, req.headers["tailscale-user-login"] || req.socket.remoteAddress) : { ok: false, error: "That gateway key isn't valid.", fix: "Check you copied the whole key." };
        return v.ok ? { key: v.key } : { ok: false, status: 401, error: v.error, fix: v.fix };
      },
    });
    if (!id.ok) return id;
    const clientCreds = creds.filter((c) => !c.value.startsWith("sdgw_") && c.where !== "x-sparkdash-key");
    let who;
    if (id.via === "key") {
      const k = id.key;
      const access = String(k.access || "");
      who = {
        kind: k.actsAs ? "person" : "key",
        login: k.actsAs || null,
        keyName: k.name,
        tags: [],
        label: k.actsAs || `key:${k.name}`,
        onlyGrantId: access.startsWith("grant:") ? Number(access.slice(6)) : null,
        extraGroups: access.startsWith("group:") ? [access.slice(6)] : [],
      };
    } else if (id.via === "local") {
      who = { kind: "local", login: null, tags: [], label: "local console" };
    } else if (id.tagged) {
      who = { kind: "tag", login: null, tags: id.tags, label: id.device || id.tags.join(",") };
    } else {
      who = { kind: "person", login: id.login, tags: [], label: id.login };
    }
    who.via = id.via;
    who.device = id.device || null;
    who.groups = [...new Set([...groupsFor(state.directory(), who), ...(who.extraGroups || [])])];
    return { ok: true, who, clientCreds };
  }

  async function readBody(req, limit) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > limit) return null;
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  }

  function grantedModels(who) {
    return providers.models().filter((m) => m.usable && grants.allowsModel(who, m.name));
  }

  // ─── /v1/models in the client's own shape; never redirected ──
  function listModels(req, res, who, gemini) {
    const models = grantedModels(who);
    res.writeHead(200, { "content-type": "application/json" });
    if (gemini) {
      const gm = models.filter((m) => m.providerType === "gemini");
      return res.end(JSON.stringify({ models: gm.map((m) => ({ name: `models/${m.name}`, displayName: m.name, supportedGenerationMethods: ["generateContent", "streamGenerateContent", "countTokens"] })) }));
    }
    if (req.headers["anthropic-version"]) {
      const am = models.filter((m) => m.providerType === "anthropic");
      const data = am.map((m) => ({ type: "model", id: m.name, display_name: m.name, created_at: "1970-01-01T00:00:00Z" }));
      return res.end(JSON.stringify({ data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null }));
    }
    res.end(JSON.stringify({ object: "list", data: models.map((m) => ({ id: m.name, object: "model", created: 0, owned_by: m.providerName })) }));
  }

  // ─── The model APIs ─────────────────────────────────────
  async function proxy(req, res, url, route, ctx) {
    const family = route.family;
    const { who, clientCreds } = ctx;
    if (!state.enabled) return sendError(res, family, 503, "The AI gateway is turned off. An Admin can turn it on from the AI Gateway page in sparkDash.");
    const body = await readBody(req, config.maxBodyBytes);
    if (!body) return sendError(res, family, 413, `The request is larger than ${Math.round(config.maxBodyBytes / 1024 / 1024)} MB, the Gateway's limit (GATEWAY_MAX_BODY_MB).`);

    let parsed = null;
    let modelName = route.model;
    if (route.modelFrom === "body") {
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        return sendError(res, family, 400, "The request body isn't valid JSON.");
      }
      modelName = typeof parsed?.model === "string" ? parsed.model : "";
      if (!modelName) return sendError(res, family, 400, "The request doesn't name a model.");
    }

    const hit = providers.resolve(modelName, route.format);
    if (hit.error) return sendError(res, family, hit.error === "conflict" ? 409 : 404, hit.message);
    if (!grants.allowsModel(who, modelName)) {
      return sendError(res, family, 403, `You don't have access to ${modelName}. Ask an Admin to add it to one of your grants on the AI Gateway page's Access tab.`);
    }

    const { provider, model } = hit;
    const ownLogin = provider.ownLogin && clientCreds.length > 0;
    let outBody = body;
    let outPath = url.pathname;
    if (provider.type === "local" && model.upstream !== model.name) {
      // Local models are named <machine>/<model>; the server knows only <model>.
      if (parsed) outBody = Buffer.from(JSON.stringify({ ...parsed, model: model.upstream }));
    }
    if (route.modelFrom === "path" && model.upstream !== modelName) outPath = outPath.replace(`/models/${encodeURIComponent(modelName)}:`, `/models/${encodeURIComponent(model.upstream)}:`);
    const query = new URLSearchParams(url.search);
    query.delete("key");
    const qs = query.toString();
    const target = `${provider.baseUrl}${outPath}${qs ? `?${qs}` : ""}`;
    const secret = ownLogin ? "" : providers.secretFor(provider.id);
    const headers = outboundHeaders(req.headers, {
      providerAuth: PROVIDER_TYPES[provider.type].auth(secret),
      ownLogin,
      bodyLength: outBody.length,
    });

    const ts = Date.now();
    const result = await forward({
      res,
      req,
      url: target,
      headers,
      body: outBody,
      agent,
      onConnectError: (status, message) => sendError(res, family, status, `${message} Provider: ${provider.name}.`),
    });
    providers.markUsed(provider.id);
    state.recordRequest({
      ts,
      identity: who.label,
      via: who.via,
      device: who.device,
      client: clientFromUserAgent(req.headers["user-agent"]),
      providerId: provider.id,
      model: modelName,
      format: route.format,
      stream: route.stream ?? Boolean(parsed?.stream),
      status: result.status,
      latencyMs: result.latencyMs,
      ttfbMs: result.ttfbMs,
      costBasis: ownLogin ? "subscription" : provider.type === "local" ? "local" : "key",
      partial: result.partial,
      sessionId: req.headers["x-claude-code-session-id"] || null,
      agentId: req.headers["x-claude-code-agent-id"] || null,
      error: result.error ? redact(result.error, [secret]) : null,
    });
    if (result.error && result.error !== "client closed") log(`[gateway] ${who.label} ${modelName}: ${redact(result.error, [secret])}`);
  }

  // ─── /me: the Connect page's data ───────────────────────
  async function me(req, res, url, ctx) {
    const { who } = ctx;
    const send = (status, obj) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(obj));
    };
    const person = who.login ? state.person(who.login) : null;
    const canHaveKeys = who.kind === "person" && who.via !== "key" && state.personalKeys;
    if (url.pathname === "/me" && req.method === "GET") {
      const last = state.lastRequestFor(who.label);
      return send(200, {
        who: { kind: who.kind, login: who.login, name: person?.name || null, label: who.label, device: who.device, role: person?.role || null, via: who.via },
        gatewayEnabled: state.enabled,
        models: grantedModels(who).map((m) => ({ name: m.name, provider: m.providerType })),
        lastRequest: last,
        personalKeys: canHaveKeys,
      });
    }
    if (url.pathname === "/me/usage" && req.method === "GET") {
      return send(200, { since: Date.now() - 30 * 86_400_000, byModel: state.usageFor(who.label, Date.now() - 30 * 86_400_000) });
    }
    if (url.pathname === "/me/keys") {
      if (!canHaveKeys) return send(403, { error: who.via === "key" ? "Personal keys are managed from a device on the tailnet." : "Personal gateway keys are turned off. Ask an Admin." });
      if (req.method === "GET") return send(200, { keys: keys.list({ actsAs: who.login }) });
      if (req.method === "POST") {
        const raw = await readBody(req, 16 * 1024);
        let b = {};
        try {
          b = JSON.parse(raw?.toString("utf8") || "{}");
        } catch {
          return send(400, { error: "The request body isn't valid JSON." });
        }
        try {
          const { key, record } = keys.create({ name: b.name, expiry: b.expiry ?? "90", actsAs: who.login, createdBy: who.login });
          return send(201, { key, record });
        } catch (err) {
          return send(err.status || 500, { error: err.status ? err.message : "That didn't save." });
        }
      }
    }
    const del = /^\/me\/keys\/(\d+)$/.exec(url.pathname);
    if (del && req.method === "DELETE") {
      if (!canHaveKeys) return send(403, { error: "Personal gateway keys are turned off." });
      try {
        return send(200, { key: keys.revoke(Number(del[1]), who.login, { onlyActsAs: who.login }) });
      } catch (err) {
        return send(err.status || 500, { error: err.message });
      }
    }
    return send(404, { error: "Not found." });
  }

  // ─── Connect page (static) ──────────────────────────────
  function serveStatic(req, res, url) {
    const file = url.pathname === "/" || url.pathname === "/connect" ? "connect.html" : url.pathname.slice(1);
    const full = path.resolve(config.staticDir, file);
    if (!full.startsWith(path.resolve(config.staticDir) + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
      if (file === "connect.html") {
        res.writeHead(503, { "content-type": "text/plain" });
        return res.end("The Connect page hasn't been built. Run npm run build.\n");
      }
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("Not found.\n");
    }
    res.writeHead(200, {
      "content-type": STATIC_TYPES[path.extname(full)] || "application/octet-stream",
      "cache-control": file.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-store",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    });
    fs.createReadStream(full).pipe(res);
  }

  return async function handle(req, res) {
    let url;
    try {
      url = new URL(req.url, "http://gateway");
    } catch {
      res.writeHead(400).end();
      return;
    }
    const family = familyFor(url.pathname, req.headers);
    try {
      // Never answer CORS preflights: no browser on another origin gets to call the Gateway.
      if (req.method === "OPTIONS") {
        res.writeHead(405, { allow: "GET, HEAD, POST, DELETE" });
        return res.end();
      }
      if ((req.method === "HEAD" || req.method === "GET") && url.pathname === "/api/hello") {
        // Claude Code's warm-up probe.
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(req.method === "HEAD" ? undefined : "{}");
      }
      const route = classify(req.method, url.pathname);
      const isModelsList = req.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/v1beta/models");
      const isMe = url.pathname === "/me" || url.pathname.startsWith("/me/");
      if (!route && !isModelsList && !isMe) {
        if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res, url);
        return sendError(res, family, 404, `The Gateway doesn't serve ${req.method} ${url.pathname}.`);
      }
      if (crossOrigin(req)) return sendError(res, family, 403, "Cross-origin requests are refused: a web page can't use the Gateway on someone's behalf.");

      const ctx = await identify(req, url);
      if (!ctx.ok) return sendError(res, family, ctx.status || 401, `${ctx.error} ${ctx.fix || ""}`.trim());
      if (!allow(ctx.who.label)) return sendError(res, family, 429, `Too many requests from ${ctx.who.label} (over ${config.ratePerMinute} a minute). Slow down and try again shortly.`, { "retry-after": "10" });

      if (isMe) return await me(req, res, url, ctx);
      if (isModelsList) return listModels(req, res, ctx.who, url.pathname.startsWith("/v1beta/"));
      return await proxy(req, res, url, route, ctx);
    } catch (err) {
      log(`[gateway] ${req.method} ${url.pathname} failed: ${redact(err?.stack || err?.message || err)}`);
      if (!res.headersSent) sendError(res, family, 502, "The Gateway hit an internal error. Check its log.");
      else res.destroy();
    }
  };
}
