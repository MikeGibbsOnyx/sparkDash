// Onyx Gateway: the only process that holds provider keys. Unprivileged, non-root.
// Public listener: GATEWAY_BIND_HOST:GATEWAY_PORT (127.0.0.1:5556). Internal API: ipc/gateway.sock.
import crypto from "node:crypto";
import dns from "node:dns";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createWhois } from "../shared/identity/index.js";
import { loadConfig } from "./config.js";
import { openGatewayDb } from "./store/db.js";
import { State } from "./store/state.js";
import { createVault, loadVaultKey } from "./credentials/vault.js";
import { GatewayKeys } from "./credentials/gatewayKeys.js";
import { Providers } from "./providers/registry.js";
import { Grants } from "./policy/grants.js";
import { Budgets } from "./policy/budgets.js";
import { Usage } from "./usage/ledger.js";
import { Energy } from "./usage/energy.js";
import { Guardrails } from "./guardrails/index.js";
import { CaptureStore } from "./logging/capture.js";
import { checkOutboundUrl } from "./security.js";
import { createUpstreamAgent } from "./proxy/forward.js";
import { createPublicHandler } from "./app.js";
import { createInternalHandler } from "./internal/server.js";

// Sparks often resolve providers' AAAA records with no IPv6 route, and Node's default 250 ms
// per-address attempt cancels a slower IPv4 connect (found in the spike). Prefer IPv4, allow 2 s.
dns.setDefaultResultOrder("ipv4first");
net.setDefaultAutoSelectFamilyAttemptTimeout(2000);

/** Build the Gateway's parts without listening (tests use this directly). */
export function createGateway(config, opts = {}) {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const db = openGatewayDb(config.dataDir);
  const state = new State(db);
  const vault = createVault(loadVaultKey(config));
  const keys = new GatewayKeys(db, { audit: state.audit });
  const providers = new Providers(db, { vault, audit: state.audit, envKeys: config.envProviderKeys, fetchImpl: opts.fetchImpl, checkUrl: opts.checkUrl });
  const grants = new Grants(db, { audit: state.audit });
  const timeZone = () => state.timeZone;
  const usage = new Usage(db, { timeZone });
  const budgets = new Budgets(db, { audit: state.audit, timeZone });
  // Settled energy cost counts toward USD budgets like any other spend.
  const energy = new Energy(db, {
    usage,
    onCost: (row, usd) => budgets.add({ kind: row.kind, login: row.kind === "person" ? row.identity : null, keyName: row.key_name, groups: JSON.parse(row.groups || "[]") }, row.ts, { usd, tokens: 0, costBasis: "local" }),
  });
  const guardrails = new Guardrails(db, { state, audit: state.audit, fetchImpl: opts.fetchImpl, checkUrl: opts.checkUrl || checkOutboundUrl });
  const capture = new CaptureStore({ dataDir: config.dataDir, state, db, audit: state.audit });
  const whois = opts.whois || createWhois({ socketPath: config.tailscaledSocket, cli: null });
  const agent = createUpstreamAgent(config);
  const version = JSON.parse(fs.readFileSync(path.join(config.root, "package.json"), "utf8")).version;
  const publicHandler = createPublicHandler({ config, state, providers, grants, keys, whois, agent, usage, budgets, guardrails, capture, log: opts.log });
  return { db, state, providers, grants, keys, usage, budgets, energy, guardrails, capture, agent, version, publicHandler };
}

/** Create the internal socket and its secret (0600), readable by the Observer. */
function listenInternal(config, handler) {
  if (Buffer.byteLength(config.socketPath) > 100) {
    throw new Error(`The internal socket path is too long for a Unix socket (${config.socketPath}). Set GATEWAY_IPC_DIR to a shorter directory.`);
  }
  fs.mkdirSync(config.ipcDir, { recursive: true });
  let secret;
  try {
    secret = fs.readFileSync(config.secretPath, "utf8").trim();
  } catch {
    secret = "";
  }
  if (!/^[0-9a-f]{64}$/.test(secret)) {
    secret = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(config.secretPath, secret + "\n", { mode: 0o600 });
  }
  try {
    fs.unlinkSync(config.socketPath);
  } catch {
    /* no stale socket */
  }
  const server = http.createServer(handler(secret));
  server.on("error", (err) => {
    console.error(`[gateway] internal API can't listen on ${config.socketPath}: ${err.message}`);
    process.exit(1);
  });
  server.listen(config.socketPath, () => fs.chmodSync(config.socketPath, 0o600));
  return server;
}

export async function main(env = process.env) {
  let config;
  try {
    config = loadConfig(env);
  } catch (err) {
    console.error(`[gateway] ${err.message}`);
    process.exit(1);
  }
  if (config.bindClass === "public") {
    console.warn(`[gateway] WARNING: listening on the public address ${config.bindHost} (GATEWAY_ALLOW_PUBLIC_BIND=1). Anyone who can reach it can try your gateway keys.`);
  }
  const gw = createGateway(config);
  await gw.providers.syncEnvProviders();
  const pub = http.createServer({ noDelay: true, requestTimeout: 0, headersTimeout: 60_000, keepAliveTimeout: 65_000 }, gw.publicHandler);
  pub.listen(config.port, config.bindHost, () => console.log(`[gateway] listening on http://${config.bindHost}:${config.port} (sparkDash ${gw.version})`));
  try {
    listenInternal(config, (secret) => createInternalHandler({ secret, ...gw, config }));
  } catch (err) {
    console.error(`[gateway] ${err.message}`);
    process.exit(1);
  }
  // Local energy cost settles as the Observer's minutes arrive.
  const settler = setInterval(() => {
    try {
      gw.energy.settle();
    } catch (err) {
      console.error(`[gateway] energy settlement failed: ${err.message}`);
    }
  }, 15_000);
  settler.unref();
  // Retention: content and request records past their age are deleted hourly.
  const purge = () => {
    try {
      const r = gw.capture.purge();
      if (r.bodies || r.metadata) console.log(`[gateway] retention: removed ${r.bodies} stored bodies and ${r.metadata} request records`);
    } catch (err) {
      console.error(`[gateway] retention purge failed: ${err.message}`);
    }
  };
  purge();
  setInterval(purge, 3_600_000).unref();
  console.log(`[gateway] internal API on ${config.socketPath}; gateway ${gw.state.enabled ? "on" : "off (turn it on from the AI Gateway page)"}`);
  const stop = () => {
    pub.close();
    gw.db.close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
