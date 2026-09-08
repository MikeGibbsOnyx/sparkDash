# FLEET-BRAIN.md — Cluster Brain Spec (DRAFT v0.1 — awaiting Mike's signature)

**Owner:** Nyx · **Task:** t_8ae76168 · **Date:** 2026-09-07
**Status: SPEC ONLY. No installs, no config, no rpc-server until Mike signs this.**

---

## 0. Ground truth (live-probed 2026-09-07 ~23:00 EDT, not assumed)

| Node | Tailscale | RAM | Running now | Disk |
|---|---|---|---|---|
| **nyx-den** (Spark 1, head) | 100.85.158.16 | 121 Gi | `vllm-fn` = vLLM serving **qwen3.8-flash-next**, 262K ctx, up since 16:21 UTC | 3.7T NVMe, 2.7T free; DS4-Flash-0731 FP8 (156G) + GLM-5.3-exl3 (166G) already on disk |
| **iris-den** (Spark 2) | 100.67.41.50 | 121 Gi | `vllm-fn` too; Comfy/Isaac lane historically here | — |
| **Spark 3** | unknown | — | Aug-21 durable ref: "single after queue/GO" | — |
| **Spark 4** | unknown | — | Aug-21 durable ref: **boxed** | — |
| **Mac Studio** | 100.125.180.48 | 36 Gi | Hermes profiles (nyx/iris/default), sparkDash :5555 prod, Obsidian vault | — |
| **thebeast** (Windows) | 100.125.236.77 | — | off dens day-path | — |

Interconnect: 192.168.50.x / QSFP between dens (RoCE proven — DS4 TP=2 ran here 2026-08-07, 41–82 t/s reports).

**Blasted assumptions this spec corrects:**
- "Four-Spark cluster" is DEAD metal for now — Aug 13 four-Spark collapse, Aug 17 cattle lock (Pair A only), Spark 4 boxed, "Nyx off dens; no metal without GO." **This spec targets Pair A (2 nodes) + a gated Spark 3 expansion.** Do not plan against 4×GB10 until Mike physically unboxes Spark 4 and the Aug-13 failure mode is root-caused.
- LiteLLM on :14000 is **exited** — the gateway is gone. Any fleet-brain wiring must re-establish a gateway or use direct endpoints.
- GLM-5.3 **is real** (zai-org/GLM-5.3, 744B-A40B MoE, weights public) but full BF16/FP8 (755G/1.5T) needs ~12+ GB10 boxes — not us. GLM on our fleet only means a Flash-class/exl3 derivative.

## 1. Target model (decision needed from Mike, recommendation given)

**Primary: DeepSeek-V4-Flash class (284B MoE).** Weights already on nyx-den (156G FP8). Best 2-node community evidence of anything in this class.
**Secondary slot: GLM-5.3-Flash / exl3 derivative** (166G already rsyncing on nyx-den) as eval/challenger — coding quality jump is real (GLM-5.3 open-weights SOTA claims), but serving evidence on GB10 clusters is thin. GLM-5.2 full on 3×GB10 hits ~16–22 t/s in the wild → **too slow to be our hands**.
**NOT** full GLM-5.3, **NOT** Kimi K3-class (needs ~16 boxes; not credible below that).

## 2. Engine (community 2-Spark reports win the tie)

| Engine | 2-Spark DS4-Flash evidence | Verdict |
|---|---|---|
| **vLLM TP=2 + MTP** (unholy/dspark forks) | **41–82 t/s**, 200–216K ctx, official FP8 weights, RoCE | **Pick.** Already our proven lane (ran it 08-07). |
| llama.cpp RPC | 8–22 t/s at extreme quants on 2–4 nodes | Only for the 1M-ctx weekend session niche, not serving. |
| ds4 native (antirez) | ~23–26 t/s single node w/ DSpark draft | Good single-node fallback; no cluster story. |
| SGLang | V4 cookbook doesn't validate GB10 | No. |

**Spec: vLLM (dspark/unholy recipe, FP8 official weights, TP=2, MTP on) as the serving engine.** llama.cpp rpc-server is explicitly OUT unless Mike overrides — the card's own gate.

## 3. Quant budget

- **Weights: official FP8** (DS4-Flash 0731). 156G splits cleanly across 2×121G with ~30–40G/node KV headroom at util 0.82–0.9.
- **KV: compressed/FP8-KV, target ≥200K ctx on Pair A** (Flowtivity 2-Spark: 1M ctx with 14.8G/node KV — we'll spec 200–256K for agent turns, KV is not the constraint).
- **No int4/int8 GGUF detour** for the primary lane — FP8 official is both the quality floor AND the community speed sweet spot. int-class quants reserved for Spark-3-solo experiments only.

## 4. Node split + co-tenancy

| Node | Role | Co-resident |
|---|---|---|
| **nyx-den** | Head/coordinator (master :29501 pattern from 08-07 recipe) + worker TP0 | serving is dominant; keep only tailscale+ssh+watchdogs. Nothing creative. |
| **iris-den** | worker TP1 | **stays Comfy/creative + Rin's Isaac lane** → serve util capped ≤0.72 when Isaac trains; creative jobs queue behind KV. (Alternative: dedicate iris-den pure-serving and move Comfy to Spark 3 — Mike call, this is the one genuinely open co-tenancy question.) |
| **Spark 3** (if GO'd) | cold spare / solo small-model slot (embeds, Qwen-27B-class) — NOT in TP group until Aug-13 interconnect failure is root-caused | |
| **Spark 4** | stays boxed; unboxing is a separate Mike decision | |
| **Mac Studio** | control plane only — Hermes profiles, dashboard, gateway/router client. **Never a serving worker** (36G, and prod dash lives there). | |

## 5. Serving target — which Hermes role-slots

| Slot | Today | Fleet-brain candidate? |
|---|---|---|
| `delegation.model` (leaf/tool/code subagents, all 3 sisters) | cloud / dead dens-brain | **YES — primary win.** This is where Grok/K3 dollars actually burn. |
| embedding/batch (memory graph, RAG chunking) | ad-hoc | **YES** if a suitable embed model fits (separate small slot, Spark 3 or co-tenant). |
| `compression.model` | house lock says Grok | NO — keep cloud (quality lock, standing decision). |
| persona/partner chat (Nyx↔Mike) | K3/Grok cloud | **NO** — cloud mind stays. Local brain is *hands*, not *mind* (house rule since 08-01). |

**Worth-it floor:** ≥30 t/s single-stream decode AND ≥1200 t/s prefill at 32K prompt, measured on OUR Pair A with the 08-07 recipe. Below that the Grok fallback is cheaper than our electricity+ops time. Hard smoke: LiteLLM-style gateway `ORNNITH_HANDS_OK`-equivalent <1s on tiny prompt (gateway bounce is a prerequisite — :14000 is dead).

## 6. What Mike must sign (four checkmarks)

1. Model: DS4-Flash primary + GLM-5.3-Flash challenger — OK?
2. Engine: vLLM TP=2 (+MTP), llama.cpp RPC stays out — OK?
3. Co-tenancy: iris-den keeps Comfy/Isaac with util cap, or goes pure-serving? ← only real open question
4. Scope: Pair A (2 nodes) now; Spark 3/4 gated on separate GO + Aug-13 postmortem — OK?

After signature: a follow-up card does the cutover (weights verify → TP=2 bring-up → gateway restore → role-slot flips behind a flag, cloud fallback stays wired).

## Appendix: evidence links (community reports, Aug-Sep 2026)

- 2×Spark DS4-Flash FP8 TP=2 MTP 200K ctx: forums.developer.nvidia.com "official FP8 across 2x DGX Spark" (260 replies, Jul 2026); Flowtivity blog: 41 t/s @1M ctx, KV 14.77G/node (Jun 2026); noze.it survey: 82 t/s @0731 TP=2 (Aug 2026)
- 4-node DS4-0731: ~56 t/s decode, 2.7K t/s prefill @100K (NV forum, Aug 23 2026) — the Spark-3/4 future ceiling
- Single-Spark DS4-Flash: 19.7–26 t/s (llama.cpp+DSpark / DwarfStar) — Pair B fallback tier
- GLM-5.2: 16–22 t/s @3–4 nodes, 8 t/s @2 nodes IQ1 — challenger class only
- GLM-5.3: zai-org/GLM-5.3 (HF), 744B-A40B, 755G repo — full-fat NOT viable <12 boxes
