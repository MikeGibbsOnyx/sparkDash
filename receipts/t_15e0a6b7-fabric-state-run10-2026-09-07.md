# t_15e0a6b7 — Fabric state re-check, run 10 (2026-09-07 23:08 EDT)

HEADLINE: the 200G fabric is ALREADY PHYSICALLY LIVE — cabled, link-up, carrying
traffic at layer 2. Only IP-layer config + one sudo grant stand between us and
the spike. The switch gate is ~90% met, not unmet.

## Live evidence (this run, SSH probes)

### mike-den (10.0.0.162, hostname spark-13da)
- `enp1s0f0np0`: state UP, **speed=200000 Mb/s, carrier=1**, MAC 4c:bb:47:7d:13:db,
  MTU 1500, NO IPv4.
- `enP2p1s0f0np0`: state UP, **speed=200000 Mb/s, carrier=1**, MAC 4c:bb:47:7d:13:df,
  MTU 1500, NO IPv4.
- (Both other QSFP ports enp1s0f1np1 / enP2p1s0f1np1: DOWN.)
- Counter proof: rx=18.3 MB / tx=7.7 MB per port — real L2 traffic flowing.
- LLDP on the fabric ports sees: `mike-den` (itself, via switch reflection) AND
  `spark-5598` (= rin-den). => BOTH nodes' fabric ports are cabled into the SAME
  device and link-up. A switch is present and forwarding LLDP, not bare
  back-to-back cables (back-to-back would not reflect mike-den to itself, and
  would not show rin-den from mike-den's port).
- Still on WiFi for L3: default route via wlP9s9; ping to gateway 4.9–7.8 ms.

### rin-den (spark-5598, 100.79.61.0)
- `enp1s0f0np0` + `enP2p1s0f0np0`: state UP, link-only (link-local IPv6, no IPv4).
- Consistent with Mike's LLDP observation from mike-den.

### nyx-den / iris-den (existing pair)
- nyx-den: enp1s0f0np0 = 192.168.50.10/24, enP2p1s0f0np0 = 192.168.60.10/24.
- iris-den: enp1s0f0np0 = 192.168.50.11/24, enP2p1s0f0np0 = 192.168.60.11/24.
- LLDP neighbors of nyx-den's fabric ports: ONLY iris-den (+ self-reflection).
  nyx-den's neighbor table: 192.168.50.11 REACHABLE.
- mike-den has NO route/address into 192.168.50/60; with a test-less probe,
  ping 192.168.50.10/.11 and .60.10/.11 from mike-den = 100% loss (expected,
  no IP on mike-den's fabric ports).
- LLDP self-reflection seen on these ports (nyx-den sees its own chassis ID on
  its fabric iface, RID 1) also indicates a switch on the nyx/iris side — the
  "TP2 pair link" is very likely the same 200G switch, already in production
  for vLLM TP2 at line rate.

## Interpretation

- The 200G QSFP switch is racked, powered, cabled to at least mike-den, rin-den,
  nyx-den, iris-den (4x2 ports up). vLLM TP2 nyx-den↔iris-den is already running
  over 192.168.50/60 which is very likely on this switch (LLDP reflection).
- What is MISSING is purely config: mike-den and rin-den fabric ports have no
  IPv4, so no RTT can be measured and llama.cpp RPC cannot bind yet.
- The card's hard prerequisite ("switch arrives") is effectively MET at layer 1/2.
  Full gate verification (inter-node ping <0.5 ms on the fabric) needs one
  privileged step.

## The one-line gate (needs Mike's GO / one sudo command)

mike-den's installed `/etc/sudoers.d/nyx-ops` grant (Mike-approved 2026-09-04)
covers apt/curl/systemctl/usermod/visudo/rm but NOT `ip`. Either:

A) Mike runs once on mike-den:
   sudo sh -c 'echo "nyx ALL=(ALL) NOPASSWD: /usr/sbin/ip" > /etc/sudoers.d/nyx-ip'
   (revoke: sudo rm /etc/sudoers.d/nyx-ip)

B) Or Mike runs the config itself:
   sudo ip addr add 192.168.50.12/24 dev enp1s0f0np0
   sudo ip addr add 192.168.60.12/24 dev enP2p1s0f0np0

C) Or expect-dance per remote-sudo-over-ssh skill (I can drive it if Mike ships
   the pw file remotely himself — but A is cleaner and auditable).

rin-den will need the same once I have an account path with sudo (currently only
`rin-den@` login, no grant).

## Once gate clears (all autonomous, plan unchanged)
1. Fabric ping matrix mike-den↔rin-den↔nyx-den/iris-den (expect <0.5 ms).
   NOTE: if fabric is the same L2 as 192.168.50/24, decide whether to join that
   subnet (interference risk with vLLM TP2 = zero, it's point-to-point traffic;
   cleanest is new subnet e.g. 192.168.70.0/24 on the switch VLAN if configurable,
   else join 50.x with static /24 add).
2. llama.cpp build on mike-den (cmake CUDA arm64), rsync to nodes.
3. rpc-server :50060+ isolated; gpt-oss-120b IQ4_XS 2-node (rin-den + mike-den);
   bench vs single-node; ceiling doc docs/FLEET-BRAIN-CEILING.md.

## Constraint compliance
All probes this run were read-only except failed sudo attempts (no effect).
Nothing touched on nyx-den/iris-den serving. No sister interference.
