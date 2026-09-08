# PAIR Evaluation — NVIDIA Personal AI Router as fleet routing layer

**Task:** t_48c660f9 · **Evaluated:** 2026-09-07 · **Evaluator:** Nyx
**Version tested:** PAIR v0.1.1 services (published 2026-08-28, Apache-2.0)
**Verdict up front:** **HOLD — conditional GO for a single-node pilot, NO fleet rollout.** Reasons at the bottom.

---

## 1. What PAIR actually is (verified, not brochure)

Local inference router for machines on the same LAN. Discovers nodes (mDNS
5353/udp), pairs them with a 6-digit PIN (mTLS after bootstrap), manages
Ollama/LM Studio engines, and exposes engine-compatible proxies on the standard
ports. Each request goes to **exactly one node**. It does NOT pool VRAM, shard
models across machines, or split in-flight requests — confirmed in the README
and architecture doc, so it can never make the Studio run a model that doesn't
fit on one box.

Endpoint semantics (decisive for us — verified in
`docs/getting-started.mdx` §7 and `architecture.mdx:203`):

- The proxy serves **plaintext HTTP on loopback only**; non-loopback clients
  get `403`, enforced by the listener, not config.
- The intended pattern is "run PAIR where you work": install on every machine
  you issue requests from, pair into the cluster, point apps at each machine's
  *local* endpoint.
- Node-to-node ports: 5353/udp (discovery), 14318–14323 (inventory, errors,
  workloads, pairing, model lists, remote engine control — all mTLS).
- Proxy takes the engine's canonical port; the engine moves up
  (Ollama → 11435+, LM Studio → 1235+).
- Hermes explicitly named as a supported client class ("any client that lets
  you set a base URL and a model name").

## 2. Spike receipts (all run 2026-09-07)

### 2.1 Install artifacts + provenance

| Artifact | SHA-256 |
| --- | --- |
| deb `NVPAIR-Setup-0.1.1-arm64.deb` | `9f64b21c99fbd2517e3ef3ab9feec7f5aa0bcf4c338fa55846f0564148442229` |
| `service-binaries-mac-arm64.zip` | `6080b89e2c8e83e842e5a163f021f4cae5747bc9c9f371af481d95550a175d8f` |
| `service-binaries-linux-arm64.zip` | `2738b0f9b436e6b5a88c2d16cbcd2443762120dc6d0c8f0de6b4808fc23f0e1f` |

- **Linux binaries match their manifest hashes exactly** (spot-verified:
  `nvpair-tui` `7b6f4686…`, `ollama-proxy` `7323bf00…` — both == manifest).
- **macOS binaries intentionally differ from the manifest hashes** — they are
  re-signed Mach-Os (size differs). Provenance instead via Apple: all
  notarized, `Developer ID Application: NVIDIA Corporation (6KR3T733EC)`,
  `spctl` verdict: **accepted, source=Notarized Developer ID**. Notarized !=
  audited, but provenance is real.
- Stage-1 sanity on Studio: `nvpair-cluster-manager -h` / `nvpair-tui -h` run
  clean; nothing installed or bound.

### 2.2 Headless node spike on nyx-den (DGX Spark GB10, arm64 Linux)

Ran the **services-only** binaries (no desktop, no `apt install` — zero
system-level change) under `tmux` as user `rin`, from `~/pair-spike/linux-arm64`:

```
NVPAIR TUI   broker ready  v0.40.2     (up 25s)
scanner / node-info / proxy / lmstudio-proxy / workload-manager /
engine-manager / manual-nodes / settings / cluster-manager  → ALL ok
```

Routing proof (the receipt that matters): from the **Studio**,
`GET http://127.0.0.1:11434/v1/models` returned the **cluster inventory** —
4 models including `qwen3:1.7b`, `ornith-1.5:9b` and two 27b/32b GGUFs, all
physically resident on **nyx-den's** Ollama, none on the Studio.
`POST /v1/chat/completions` with `qwen3:1.7b` from the Studio returned a real
completion (`"OK."`, `finish_reason` set, reasoning chain present) — served
cross-node through PAIR's loopback proxy. **Loopback-only + cross-node routing
both confirmed live.**

### 2.3 Port-takeover audit (the finding that changes the rollout story)

- **Studio:** PAIR proxy won `:11434` (proxy + lmstudio-proxy also bound
  `:1234`, `*:14320–14323`). Our **pre-existing Ollama (0.33.2) was NOT moved
  to 11435 — it stayed bound to 11434 and shadowed the proxy on loopback**:
  local `curl :11434` hit the old engine (Studio's own 4-model inventory),
  while the PAIR proxy served the cluster view. Two servers on one port,
  different bind scopes, ambiguous winner. `getting-started.mdx` says PAIR
  "moves the engine" — true only for engines it manages; a foreign engine
  already on 11434 produces exactly this split-brain.
  **Corollary (good news):** Hermes clients on the Studio pointing at
  `localhost:11434` keep working *unchanged against the old engine* — PAIR
  adoption cannot break them, it just doesn't route them either.
- **nyx-den:** PAIR's proxies landed on `*:11434`/`*:1234`/`*:1432x`; the
  system-socket-activated `ollama` daemon kept `:11434`, and from nyx-den
  loopback, `:11434` answered with the **old engine's empty inventory** while
  `:11435` (PAIR proxy) had no usable upstream. PAIR's own `/v1/models`
  returned `data: null` locally. Same shadowing, opposite symptom.
  (Note: nyx-den's system Ollama inventory is `{"models":[]}` at the socket —
  the real models live in the engine behind the GLM endpoint / other storage.)
- **Rule for any pilot:** a node must have its canonical engine ports
  (`11434`/`1234`) FREE, or PAIR must own the port outright (stop/move the
  foreign engine first). "Endpoints is authoritative" — trust it over muscle
  memory.
- Other fleet engines on non-canonical ports (`:8000` vLLM, `:8888` vLLM/glm,
  `:14000` litellm, `:8013` huihui, `:8188` ComfyUI) are untouched by PAIR —
  but also **invisible to it** (see §4).

### 2.4 Hermes config-swap check (dry, config read only — no live edit)

Current Nyx providers (`~/.hermes/profiles/nyx/config.yaml`): primary is
`custom:qwen38-flash` → `http://100.85.158.16:8888/v1` (nyx-den vLLM), plus
`ollama` → `http://localhost:11434/v1`, `ds4-local`, `litellm`, `glm-local`
(direct tailscale:ports), `huihui` (iris-den:8013).

- Swap mechanics are trivial: add a `custom_providers` entry with
  `base_url: http://127.0.0.1:11434/v1` (PAIR proxy, OpenAI mode) — exactly
  the shape PAIR documents for Hermes.
- **But PAIR routes Ollama/LM Studio engines only.** vLLM and litellm backends
  are outside its routing domain. Our primary brain (`qwen3.8-flash-next` on
  vLLM :8888) and our router-of-record (litellm :14000) would bypass PAIR
  entirely; only Ollama-resident models would benefit.
- PAIR's loopback-only rule means each machine needs its own PAIR instance to
  gain routing (vs. today's single tailscale endpoint) — i.e. it's a
  per-machine install across the fleet, not one router box.

## 3. Router-host decision (step 1 of the card)

**Recommendation: the Mac Studio as the routing *consumer* host** (its local
endpoint is what Hermes and sparkDash tools use), **nyx-den and iris-den as
engine nodes**, and **no dedicated "router appliance"** — that architecture
doesn't exist in PAIR (endpoint == where you work, enforced). nyx-den is the
wrong place for the *consumer* endpoint because its 11434 is already occupied
by production Ollama and its GPU is pinned ~95% by the vLLM brain — PAIR's
job-count+utilization scheduler would see it as the busiest node anyway.

## 4. Scheduling fit for OUR fleet (architecture doc §Scheduler Limitations)

This is the part that caps the upside. PAIR's one policy ranks nodes by
**queued job count + coarse GPU utilization signal** and ignores GPU model,
free VRAM, latency, model warmness, and request cost. Consequences for us:

- Our fleet is **maximally mixed** (GB10 128GB-unified vs Studio 36GB vs
  consumer GPU boxes). "Same utilization = same pressure" is exactly wrong
  across these machines — work will land on the Studio about as often as on a
  den while a GB10 idles.
- **External work is invisible**: our vLLM/GLM Comfy-heavy workloads don't
  emit PAIR workload events, and a request routed to a node cold-loading a
  32B model isn't penalized. One huge job == one tiny job.
- Model-warmness ignored → cold-load roulette on a 27b GGUF is real latency.
  ("Preferred among the nodes that *have* the model" softens this only when
  the model is on one node.)

NVIDIA itself says this in the README ("better fit for similar machines than a
highly mixed cluster") and it's the #1 known-issue. Our fleet is the poster
child for "highly mixed."

## 5. Beast participation (step 5)

No opinion needed yet: **thebeast was offline during the spike** (tailscale:
last seen 1h ago), Windows nodes are supported but Windows-on-ARM is
experimental and it's the one box we can't currently touch. Defer to a later
phase; do not count it in any pilot.

## 6. Stability / ops risk register

| Risk | Severity | Evidence |
| --- | --- | --- |
| Beta age: 10 days old at eval | Med | released 2026-08-28 |
| Headless supervision gap: TUI dies with the session unless tmux; no systemd unit ships for services-only; TUI can't list/delete models, change engine ports, update engines, or see which node served a job | Med–High | terminal-interface.mdx "What the TUI Cannot Do" |
| Stuck-service blind spot: crashed services restart, *hung* ones do not — state silently stops updating | Med | known-issues.mdx |
| macOS flake: unclustered macOS nodes can stop answering LAN connections (fix = restart) | Med on Studio | known-issues.mdx |
| Port split-brain with foreign engines on 11434/1234 | **High — CONFIRMED locally** | §2.3 receipts |
| TUI + desktop app on same machine = port/worker fights | Low (avoidable, documented) | terminal-interface.mdx |
| Version skew unsupported (all nodes must match) | Low–Med | getting-started §Keeping Up to Date |
| macOS manifest hashes don't match shipped binaries (provenance rests on Apple notarization) | Low, informational | §2.1 |

## 7. Comparison with what we already run

Today: pinned base URLs per provider + **litellm (:14000) as our explicit
router** across the heavy backends (it does model-level routing, retries,
and we control it; works over tailscale for every machine). PAIR would add:
automatic LAN discovery, cluster model inventory, engine lifecycle
(start/stop/install) — but *less* control, per-machine installs, loopback-only
endpoints, and Ollama/LM Studio-only engines. For our shape, litellm + pinned
vLLM already covers the routing need; PAIR's unique value is **GGUF/Ollama
model mobility across den boxes without hardcoding which box has which model**.

## 8. Decision

**NO-GO for fleet rollout now. Conditional GO for a contained pilot:**

1. **Host:** Mac Studio as consumer endpoint.
2. **Prereq (blocking):** resolve the 11434 split-brain deliberately — either
   move our Studio Ollama to a non-canonical port and let PAIR own 11434, or
   keep our engine and pin PAIR's proxy elsewhere (proxy port is editable).
3. **Nodes:** pair nyx-den + iris-den only (both already run Ollama + are
   always-on). Keep the TUI in tmux; add a user-level systemd unit to
   supervise it (the installer's postinst path is the supported alternative
   but that's a fleet-change we don't do without Mike GO).
4. **Scope:** Ollama-routed auxiliary traffic only (vision aux, cheap
   completions). Primary brain stays vLLM:8888 / fallback grok — unchanged.
5. **Gate before anything expands:** 24–48h soak; watch for hung-service
   stall, macOS LAN flake, and mis-routes onto the Studio's 36GB box.
6. **thebeast:** deferred (offline; Windows support untested here).

Kill switch is cheap and verified-in-docs: leave the cluster from the TUI
(Cluster tab → `L`), remove binaries; model weights live in `~/.ollama` and
are never touched. On a `.deb` install it'd be `apt remove nvpair`.

If after the soak the mis-routing rate on mixed hardware is noticeable (our
prior expectation: it will be), the right end-state is **keep litellm as the
router** and let PAIR ride only where its auto-discovery saves us manual
inventory work — or revisit when their scheduler gains capacity-aware
policies, which is explicitly on their roadmap.
