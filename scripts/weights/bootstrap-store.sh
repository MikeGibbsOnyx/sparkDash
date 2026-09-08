#!/usr/bin/env bash
# Bootstrap canonical origin /srv/weights on THIS box (intended: rin-den).
# Default = dry-run. Apply requires WEIGHTS_STORE_GO=1 and --apply.
# Does NOT ingest models. Does NOT touch nyx-den/iris-den.
set -euo pipefail

APPLY=0
if [[ "${1:-}" == "--apply" ]]; then APPLY=1; fi

STORE="${WEIGHTS_STORE_ROOT:-/srv/weights}"
OWNER_USER="${WEIGHTS_OWNER_USER:-weights}"
OWNER_GROUP="${WEIGHTS_OWNER_GROUP:-weights}"
LOCAL_USER="${SUDO_USER:-${USER:-$(id -un)}}"

plan() {
  cat <<EOF
bootstrap plan (host=$(hostname) user=$(id -un) store=$STORE)
  1. groupadd --system $OWNER_GROUP          (skip if exists)
  2. useradd --system --home $STORE --shell /usr/sbin/nologin --gid $OWNER_GROUP $OWNER_USER
  3. usermod -aG $OWNER_GROUP $LOCAL_USER    (so the login user can write)
  4. mkdir -p $STORE
  5. chown $OWNER_USER:$OWNER_GROUP $STORE
  6. chmod 2775 $STORE                       (setgid: family dirs inherit group)
EOF
}

need_go() {
  if [[ "${WEIGHTS_STORE_GO:-}" != "1" ]]; then
    echo "refusing: WEIGHTS_STORE_GO=1 required for --apply" >&2
    exit 2
  fi
}

if [[ "$APPLY" -eq 0 ]]; then
  plan
  echo "dry-run; re-run: WEIGHTS_STORE_GO=1 $0 --apply"
  exit 0
fi

need_go
plan

if [[ "$(id -u)" -ne 0 ]]; then
  SUDO=(sudo -n)
else
  SUDO=()
fi

if ! getent group "$OWNER_GROUP" >/dev/null; then
  "${SUDO[@]}" groupadd --system "$OWNER_GROUP"
fi
if ! getent passwd "$OWNER_USER" >/dev/null; then
  "${SUDO[@]}" useradd --system --home "$STORE" --shell /usr/sbin/nologin --gid "$OWNER_GROUP" "$OWNER_USER"
fi
if [[ -n "$LOCAL_USER" ]] && getent passwd "$LOCAL_USER" >/dev/null; then
  "${SUDO[@]}" usermod -aG "$OWNER_GROUP" "$LOCAL_USER"
fi
"${SUDO[@]}" mkdir -p "$STORE"
"${SUDO[@]}" chown "$OWNER_USER:$OWNER_GROUP" "$STORE"
"${SUDO[@]}" chmod 2775 "$STORE"

echo "OK $STORE $(ls -ld "$STORE")"
