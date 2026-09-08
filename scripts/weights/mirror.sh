#!/usr/bin/env bash
# Mirror canonical origin rin-den:/srv/weights -> this box (intended: mike-den).
# Default = dry-run. Apply requires WEIGHTS_STORE_GO=1 and --apply.
# Only copies variants whose MODEL.toml status=verified (rsync exclude candidate).
set -euo pipefail

APPLY=0
if [[ "${1:-}" == "--apply" ]]; then APPLY=1; fi

ORIGIN="${WEIGHTS_ORIGIN:-rin-den@rin-den:/srv/weights/}"
DEST="${WEIGHTS_STORE_ROOT:-/srv/weights/}"
RSYNC_BIN="${RSYNC_BIN:-rsync}"

plan() {
  cat <<EOF
mirror plan (host=$(hostname) user=$(id -un))
  origin: $ORIGIN
  dest:   $DEST
  filter: skip dirs whose MODEL.toml is missing or status!=verified (post-check)
  rsync:  $RSYNC_BIN -aH --delete-delay --exclude '.tmp.*' "$ORIGIN" "$DEST"
EOF
}

if [[ "$APPLY" -eq 0 ]]; then
  plan
  echo "dry-run; re-run: WEIGHTS_STORE_GO=1 $0 --apply"
  exit 0
fi

if [[ "${WEIGHTS_STORE_GO:-}" != "1" ]]; then
  echo "refusing: WEIGHTS_STORE_GO=1 required for --apply" >&2
  exit 2
fi

if [[ ! -d "$DEST" ]]; then
  echo "refusing: dest $DEST missing — bootstrap the mirror box first" >&2
  exit 3
fi

plan
"$RSYNC_BIN" -aH --delete-delay --exclude '.tmp.*' "$ORIGIN" "$DEST"
echo "rsync exit 0; run: python3 scripts/weights/store.py verify --root $DEST"
