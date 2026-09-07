# sparkDash audit remediation summary — 2026-09-07

Writable target: `MikeGibbsOnyx/sparkDash` only. Mia’s repository and the live fleet were not mutated.

All six draft PRs remain **draft**. None were merged.

## Exact remote heads (read back)

| PR | Branch | Head SHA | Title |
|----|--------|----------|-------|
| #1 | `onyx/remediate-security` | `5f57913ad80c639c203566bece14af149179835e` | fix: secure dashboard administration and remote targets |
| #2 | `onyx/remediate-durability` | `dcd5631d46d102d4d3542bbf4610de18436911aa` | fix: make registry and fleet energy state durable |
| #3 | `onyx/remediate-telemetry` | `7313df83768591bb881a467a62f49bc946cb4d8b` | fix: make live telemetry honest and bounded |
| #4 | `onyx/remediate-product-ux` | `7f91217adbcce527298bd183ba62d9b94555aa39` | feat: complete fleet operations UX |
| #5 | `onyx/remediate-install-ops` | `f0764128c475826b0eeb37688b8bbdf92cd57b32` | fix: simplify secure installation and operations |
| #6 | `onyx/remediate-validation` | `92a9e0fcf80ff3b4bbda3d07091e634d7f93cabc` | test: prove audit remediation end to end |

Base for every PR: `onyx/pr-backlog-integration-2026-09-06`.

Local aggregate: `onyx/audit-remediation-2026-09-07`.

## What each PR now contains

**#1 Security**
- Production `qs` advisories resolved.
- Bearer `SPARKDASH_TOKEN` for mutations and remote telemetry.
- Remote bind without a token fails closed.
- Allowlisted one-off benchmark hosts (`SPARKDASH_BENCH_HOSTS`).
- Bounded rate limiter, benchmark work budgets, global active-job cap.

**#2 Durability / energy**
- Registry mutations persist before mutate; persist failure is HTTP 500.
- Fleet membership add/remove invalidates energy aggregates until restart.
- Wh/output-token uses only full-fleet-covered token intervals.

**#3 Telemetry**
- Initial WebSocket snapshot is unicast to the new client.
- Benchmark streaming resources are released on abort/shutdown.
- Snapshots carry `generatedAt`; disconnect/stale banner uses `max(10s, 3× interval)`.
- Timestamped ring-buffer history with disconnect gaps.

**#4 Product UX**
- Shared action-error banner.
- Fleet Energy card on Overview, including membership-changed / partial / empty states.
- Search/status filters for up to 12 units.
- Fleet exception strip.
- Dialog focus trap + `aria-current` navigation.

**#5 Installation / operations**
- Capability-specific connectivity (host/LLM/Comfy; required vs skipped).
- Local units save/test without LAN IP.
- Compose defaults to loopback; remote bind is opt-in.
- `/api/health` preflight.
- README + remote-access migration notes.

**#6 Validation**
- Vitest/jsdom frontend harness.
- Coverage for banners, Fleet Energy states, history/ring buffer, tabs, lifecycle WS contract.

## Gates run on the local aggregate

- `npm test`: **304/304 pass**
- `npm run typecheck`: pass
- `npm run build`: pass (JS 460.59 kB / 129.83 kB gzip)
- `npm audit --omit=dev`: **0 production vulnerabilities**
- Docker image present: `sparkdash:remediation-lockfile-test` `eddacf9aeb76`
- Compose files default `BIND_HOST=${BIND_HOST:-127.0.0.1}` (no hardcoded `0.0.0.0`)

## Isolated process smoke (ports 18055–18057, not the live `:5555` fleet)

- Loopback health `ok`, `authMode=loopback-open`.
- Loopback anonymous local-unit POST: **200**.
- Remote bind without token: health/mutations **403** (`Remote access requires SPARKDASH_TOKEN`).
- Remote bind with token: anonymous POST **401**, bearer POST **200**, wrong token **401**.

## Installation migration

Previous Compose exposed `http://<host-ip>:5555`. After this remediation:

1. Default is `http://127.0.0.1:5555`.
2. Remote access: SSH tunnel, authenticated reverse proxy / Tailscale Serve, **or** `BIND_HOST=0.0.0.0 SPARKDASH_TOKEN=...`.
3. Rollback: `BIND_HOST=127.0.0.1 docker compose up -d --force-recreate`.

## Known limits / deferred

- No Playwright visual matrix at 320/768/1024/1440. 4/8/12 coverage is jsdom/component, not screenshots.
- Full Docker compose plugin was missing on this host; image build succeeded earlier via user-local Colima. Live compose up was not used (would collide with fleet).
- Cookie/session CSRF was not added; remote browser auth is bearer via optional `localStorage.sparkdashToken` / `?token=`.
- Live historical energy membership migration remains deferred (restart-required invalidation is the first-release contract).
- Least-privileged host-metrics helper remains deferred.

## Non-goals honored

- Drafts not merged.
- No upstream PR to Mia.
- Live fleet on `:5555` was not restarted, rebound, or rewritten.
