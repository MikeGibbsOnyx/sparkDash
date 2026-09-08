# t_15e0a6b7 — Pre-switch fabric readiness audit

Date: 2026-09-07 22:53–23:05 EDT (run 9). No spike executed — hard prerequisite (fast
switch) not met. This receipt records the live-state recon so the post-switch spike
starts cold-free.

## Host inventory (live-verified via SSH)

| Node | GB10? | RAM total | RAM avail | LLM serving | llama.cpp rpc-server | GGUFs on disk | Disk free |
|---|---|---|---|---|---|---|---|
| nyx-den (100.85.158.16 / 10.0.0.168) | yes | 121 GB | ~0 GB | vLLM :8888 (GPU 93%, node-rank 0 of 2-node TP2 vs 192.168.50.10) | absent | none | 2.7 TB |
| iris-den (100.67.41.50 / 10.0.0.193) | yes | 121 GB | ~2 GB | vLLM (Worker_TP1_EP1 visible) | absent | none | 2.3 TB |
| rin-den (100.79.61.0 / 10.0.0.144, hostname spark-5598) | yes | 121 GB | 76 GB | idle | absent | none | 2.9 TB |
| mike-den (100.65.30.25 / 10.0.0.162, hostname spark-13da) | yes | 121 GB | 114 GB | idle | absent | none | (not sampled) |

All four: 3.7 TB NVMe, no llama.cpp/rpc-server binaries anywhere, zero GGUF >1 GB
found. rag: ollama serve resident on nyx-den + iris-den (not the fleet brain).

## Network state (LAN 10.0.0.0/24, current switch)

RTT from mike-den (measured, ping avg):
- mike-den → nyx-den: 7.9 ms (min 6.7)
- mike-den → iris-den: 23.3 ms (min 12.4)
- mike-den → rin-den: 4.0 ms
- loopback-ish self: 0.07 ms

WiFi interface (wlP9s9) on the dens. These latencies are pipeline-parallel-hostile;
llama.cpp RPC decode requires <<1 ms inter-node. Confirms the card's premise: the
fast switch is a genuine hard gate, not a nice-to-have.

## SSH access map (verified this run)

- nyx-den: root@ via id_ed25519 / id_ed25519_nyx ✓
- iris-den: root@ via id_ed25519_iris ✓ (default id_ed25519 also works from Studio)
- rin-den: rin-den@ via default id_ed25519 ✓ (NOT the nyx key)
- mike-den: mike-den@ via id_ed25519_nyx ✓ (ssh host alias `mike-den`)
- Tailnet policy blocks cmgibbs@ SSH to sister dens from Studio (use root@ + keys above).

## Blockers for the spike

1. **Switch not arrived.** No 4th-spark fabric evidence anywhere: sparks.json lists
   exactly 4 nodes (all accounted above), no new spark MACs (4c:bb:47:* = GB10 OUI)
   answering on LAN from nyx-den, no CX7/192.168.50.x fabric beyond the existing
   nyx-den↔iris-den vLLM TP2 pair link (192.168.50.10 side).
   NOTE: card body says "4 Sparks split" but 2 of the current 4 Sparks are permanently
   spoken for by sisters' serving (nyx-den + iris-den run vLLM with ~0 GB headroom).
   Post-switch, the honest split candidate set is rin-den + mike-den + any newly
   arrived Sparks. If no new Sparks arrive, the layer-split test can only run on
   rin-den + mike-den (2×128 GB → ~200B-class Q4 MoE ceiling, not 4-node).
2. **No llama.cpp builds** on any Spark (ARM64 Grace). Spike step 0 = build or fetch
   rpc-server (CUDA backend for GB10 sm_121, or Vulkan), install to /opt, isolated
   port range (e.g. 50060-50063) to avoid sister ports 8001/8888.
3. **No GGUF models** in the 120B–200B class staged anywhere. models-staging/ empty.
   Candidate: Kimi-K2 / Qwen3-235B are too big for 2-node; realistic first target on
   2 nodes = gpt-oss-120b (5.1B active MoE, ~65 GB Q4) — good spike fit; 4-node
   opens GLM-4.5-Air / 120B-class full-fat and ~200B Q4 territory.

## Ready-to-run spike plan (executes when switch lands + 4th fabric verified)

1. Verify fabric: `ip -br a` on all dens; expect 10G/25G/40G wired iface with
   inter-node ping <0.5 ms. Receipt: ping matrix JSON.
2. Build llama.cpp (cmake, CUDA=ON, arm64) on mike-den; rsync binaries to all nodes.
3. `rpc-server -p 5006X` per node, isolated from serving ports; confirm no interference
   with 8001/8888 (nvidia-smi before/after).
4. `llama-server -m gpt-oss-120b-IQ4_XS.gguf --rpc 5006A,5006B[,5006C,5006D]` on
   mike-den; bench `-p` 512-token prompt + `-n 128` generate; capture t/s.
5. Baseline: same GGUF single-node on mike-den.
6. Ceiling doc: docs/FLEET-BRAIN-CEILING.md — max params vs node count at Q4,
   t/s curve, which Hermes role-slot is viable (target: 'fleet-brain' slot, NOT
   iris-den's live LLM during her hours).

## Decision made this run

Task stays blocked on the hard prerequisite (switch). Nothing shipped, nothing
disturbed on production dens. All recon is read-only.
