# t_8f548a73 — weights store GO packet (2026-09-08 00:00 EDT)

**Status:** tooling implemented + locally tested. **No dens writes.** `/srv/weights` does not exist. First 3 family ingests did **not** run.

Owner: Nyx. Spec: `docs/FLEET-OPS.md` §1. Tooling: `scripts/weights/` on branch `onyx/weights-store-2026-09-07`.

---

## Live recon (this run, read-only)

| Box | Probe | Disk | `/srv/weights` | Notes |
|---|---|---|---|---|
| **rin-den** (`rin-den@`, spark-5598) | SSH OK 2026-09-08T03:49Z | 3.7T, **2.9T free** | **missing** (`/srv` empty, root:root) | idle, 117G avail RAM. `sudo -n` NOPASSWD ALL. no `weights` user/group. rsync 3.2.7, sha256sum, Python 3.12.3. `/data` missing. 193G already at `/home/rin-den/models/llm` (Compass/Qwen — **not** the first-3 families). |
| **mike-den** (`mike-den@`) | SSH OK | 3.7T, **3.4T free** | **missing** | 114G avail RAM. sudoers.d/nyx-ops = apt/curl/usermod/visudo **only** — `sudo -n true` fails. `/data` missing. 57G at `/home/mike-den/models` (ASR/OCR/embed/VLM — not first-3). |
| **nyx-den** | SSH **timeout** (hostname, 100.85.158.16, 10.0.0.168) | unknown this run | unknown | Tailscale: `active; relay "tor"; offline, last seen 8m` at probe. **Cannot locate DS4-Flash FP8 / GLM exl3 to ingest.** Last known (FLEET-BRAIN / fabric receipt, not re-measured): 156G + 166G on nyx-den disk. |
| **iris-den** | SSH **timeout** | unknown | unknown | Tailscale: `offline, last seen 1m`. Not in first-ingest set. |
| **Mac Studio** | local | `/srv` does not exist | n/a | recorded test gate ran here |

Zero GGUF >1M on rin-den / mike-den this run (find over `/home`). gpt-oss-120b IQ4_XS is still **not on disk anywhere we could reach**.

rin-den existing models (do **not** ingest, do **not** delete):

| path | size |
|---|---|
| `/home/rin-den/models/llm/compass-27b-v2-38-merged` | 51G |
| `/home/rin-den/models/llm/compass-27b-v3-merged` | 51G |
| `/home/rin-den/models/llm/Qwen3.8-27B` | 52G |
| `/home/rin-den/models/llm/Qwen3.8-27B-AEON-ULTIMATE-UNCENSORED-NVFP4` | 20G |
| `/home/rin-den/models/llm/Qwen3-Embedding-8B` | 15G |
| `/home/rin-den/models/llm/Qwen3-Reranker-4B` | 7.6G |

---

## What shipped (this card, no dens writes)

| path | role |
|---|---|
| `scripts/weights/store.py` | ingest / verify / manifest / pull. Stdlib. Default dry-run. Canonical `/srv/weights` writes require `WEIGHTS_STORE_GO=1` **and** `--apply`. |
| `scripts/weights/bootstrap-store.sh` | plan: system user+group `weights`, `mkdir /srv/weights`, `chmod 2775`. Dry-run default. |
| `scripts/weights/mirror.sh` | rin-den → mike-den rsync plan. Dry-run default. |
| `scripts/weights/test_store.py` | recorded gate (tmpdir only). |
| `scripts/weights/README.md` | operator notes |

Tree convention (locked):

```
/srv/weights/<family>/<variant>/
    MODEL.toml      # name, family, quant, params, size_bytes, source, ingested_utc, verified_by, status
    MODEL.sha256    # GNU sha256sum two-space format, payload only
```

family lowercase (`deepseek`, `glm`, `gpt-oss`). variant = exact upstream id. status: `candidate` → `verified` → `retired`. Retire = status change, never silent delete.

---

## Mike GO — exact commands (do not run until GO)

Blast radius: ~0.6T writes on rin-den NVMe if both DS4+GLM copy; gpt-oss-120b IQ4_XS is a **new download** (~63G from Hugging Face, not a nyx-den copy). nyx-den disk is **not** freed until a later, separately-GO'd delete after verified copies exist. Serving pair is not touched by bootstrap/ingest (rsync **off** nyx-den, never onto it). Rollback: `rm -rf /srv/weights/<family>/<variant>` as `rin-den` once the dir is group-writable; bootstrap user/group undo is `userdel weights; groupdel weights; rmdir /srv/weights`.

### G0 — nyx-den must answer SSH first

Ingest of DS4 / GLM cannot start while nyx-den is unreachable. Re-probe:

```
ssh -o BatchMode=yes -o ConnectTimeout=8 -i ~/.ssh/id_ed25519_nyx -o IdentitiesOnly=yes root@nyx-den \
  'du -sh /data/models/llm/* /data/models/* 2>/dev/null | sort -h'
```

Need live paths + sizes for DS4-Flash FP8 and GLM exl3 before G2. If they have moved, stop and re-plan — do not guess.

### G1 — bootstrap origin on rin-den

```
ssh rin-den@rin-den
# copy scripts/weights onto the box, then:
WEIGHTS_STORE_GO=1 bash scripts/weights/bootstrap-store.sh --apply
ls -ld /srv/weights     # expect drwxrwsr-x weights weights
```

Requires `sudo -n` (rin-den already has NOPASSWD ALL — measured this run).

### G2 — ingest 1+2 from nyx-den (after G0)

Paths below are **FLEET-BRAIN last-known, not re-measured**. Replace `$DS4_SRC` / `$GLM_SRC` with the live `du` paths from G0.

```
# on rin-den, after newgrp weights (or re-login)
rsync -aH --info=progress2 nyx-den:$DS4_SRC/ /srv/weights/deepseek/DS4-Flash-0731-FP8/
WEIGHTS_STORE_GO=1 python3 scripts/weights/store.py ingest \
  --source /srv/weights/deepseek/DS4-Flash-0731-FP8 \
  --family deepseek --variant DS4-Flash-0731-FP8 --quant FP8 --params 284B-MoE \
  --source-host nyx-den --in-place --verify-after --apply --root /srv/weights

rsync -aH --info=progress2 nyx-den:$GLM_SRC/ /srv/weights/glm/GLM-5.3-exl3/
WEIGHTS_STORE_GO=1 python3 scripts/weights/store.py ingest \
  --source /srv/weights/glm/GLM-5.3-exl3 \
  --family glm --variant GLM-5.3-exl3 --quant exl3 \
  --source-host nyx-den --in-place --verify-after --apply --root /srv/weights
```

Do **not** delete nyx-den copies in this GO. Freeing ~320G is a **second** GO after `store.py verify` PASS on both + optional mike-den mirror PASS.

### G3 — ingest 3: gpt-oss-120b IQ4_XS (download, not a copy)

Nothing on disk. Candidate: `bartowski/openai_gpt-oss-120b-GGUF` file `gpt-oss-120b-IQ4_XS.gguf` (~62.71G). Confirm the filename on the model card before `hf download`. rin-den has 2.9T free.

```
# HF CLI on rin-den (venv, not system pip — PEP-668)
WEIGHTS_STORE_GO=1 python3 scripts/weights/store.py ingest \
  --source $DOWNLOADED_DIR --family gpt-oss --variant gpt-oss-120b-IQ4_XS \
  --quant IQ4_XS --params 120B --hf-repo bartowski/openai_gpt-oss-120b-GGUF \
  --verify-after --apply --root /srv/weights
```

### G4 — mike-den mirror (separate, after at least one `verified` variant)

mike-den cannot `sudo -n` mkdir `/srv`. Needs either Mike password/sudoers expand (groupadd/useradd/mkdir/chown/chmod) or Mike runs bootstrap himself:

```
# on mike-den, as root or with a grant:
WEIGHTS_STORE_GO=1 bash scripts/weights/bootstrap-store.sh --apply
WEIGHTS_STORE_GO=1 bash scripts/weights/mirror.sh --apply
python3 scripts/weights/store.py verify --root /srv/weights
```

`mirror.sh` origin default: `rin-den@rin-den:/srv/weights/`. Fabric IPv4 is still missing (G4 in FLEET-OPS) — rsync will ride Tailscale until that lands; slower, still correct.

### G5 — verification cron (rin-den, local-only)

Not installed. Proposed (GO to install):

```
# rin-den crontab, cheap, local, no network
15 4 * * * WEIGHTS_STORE_ROOT=/srv/weights python3 /home/rin-den/sparkDash/scripts/weights/store.py manifest --root /srv/weights --verified-only > /var/log/weights-manifest.json 2>/dev/null
```

Regenerate `receipts/weights-manifest.json` in the repo is a **commit**, not a cron — do that by hand after each verified ingest.

---

## Explicitly NOT in this GO

- Delete/rsync-off of nyx-den DS4 or GLM (second GO, after verify).
- Any write on nyx-den / iris-den.
- Distributed FS, NFS, new hardware.
- Installing the cron.
- Fabric IPv4 (different card).
- Creative families (LTX / PinkCherry / bigLust) — later ingest, same protocol.

---

## Recorded test gate (Studio, 2026-09-08)

```
python3 scripts/weights/test_store.py
```

See the card comment for the live output. Dry-run bootstrap + GO-refusal + ingest/verify/manifest/pull + tamper-detect.

---

## Rollback

| Step | Undo |
|---|---|
| bootstrap user/group/dir | `sudo userdel weights; sudo groupdel weights; sudo rm -rf /srv/weights` (only if empty of payloads you care about) |
| one variant | `rm -rf /srv/weights/<family>/<variant>` |
| mike-den mirror | same on mike-den; origin on rin-den is untouched |
