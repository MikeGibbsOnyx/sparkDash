# t_631f607c — FLEET-BRAIN inventory reconcile

Date: 2026-09-07 ~23:45–23:55 EDT
Branch: onyx/fleet-ops-2026-09-07 (worktree /private/tmp/sparkdash-fleetops)
Scope: doc-only. No serving, no config, no IPv4, no sudo.

## What changed

docs/FLEET-BRAIN.md v0.1 → v0.2:

- §0 table: Spark 3 unknown / Spark 4 boxed → rin-den (spark-5598, 100.79.61.0) + mike-den (spark-13da, 100.65.30.25)
- Interconnect: 200G QSFP switch recorded as L1/L2 live (4×2 ports @ 200000 Mb/s, LLDP reflection); IPv4 still missing on rin/mike
- Blasted-assumptions split: inventory (four dens live, no boxed fifth) vs serving-scope policy (Pair A only until Aug-13 postmortem) — live ≠ in the TP set
- §3/§4/§5/§6.4: "Spark 3/4" names replaced; iris-den Comfy alternative now points at rin-den
- §6 four checkmarks remain unsigned. Naming the boxes is not a signature.

docs/FLEET-OPS.md §0 discrepancy flag rewritten as reconciled, so the two docs stop contradicting each other.

## Live re-probe this run (read-only)

| Check | Result |
|---|---|
| tailscale | nyx-den 100.85.158.16 (offline, last seen ~8m), iris-den 100.67.41.50 (relay), rin-den 100.79.61.0 (direct), mike-den 100.65.30.25 (direct), Studio 100.125.180.48, thebeast 100.125.236.77 (offline ~2h) |
| ssh rin-den@rin-den | hostname spark-5598, 121G total / 117G avail, fabric enp1s0f0np0 + enP2p1s0f0np0 UP, speed 200000, no IPv4 |
| ssh mike-den | hostname mike-den, 121G total / 114G avail, same two fabric ports UP 200000, no IPv4; LLDP neighbor spark-5598 on wifi iface (plus InsideWiFi) |
| ssh nyx-den / iris-den | timed out this pass — Pair A serving picture kept from t_15e0a6b7 run 9–10, not invented |

## Not done (correctly)

- No §6 signature claimed
- No fabric IPv4
- No TP expansion onto rin-den/mike-den
- No mapping of which idle den used to be "Spark 3" vs "Spark 4" (unproven, irrelevant)
