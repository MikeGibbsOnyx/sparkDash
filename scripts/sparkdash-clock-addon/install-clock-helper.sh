#!/bin/sh
# install-clock-helper.sh — one-time provisioning for sparkDash clock control.
#
# Run ON the DGX Spark host with sudo, from the account the dashboard SSHes in
# as (its "SSH user" in Edit Spark):
#   sudo ./install-clock-helper.sh
# or name that account explicitly:
#   sudo SPARKDASH_SSH_USER=dgx ./install-clock-helper.sh
#
# Installs:
#   1. /usr/local/bin/sparkdash-set-clock  (root-owned, 0755)
#   2. /etc/sudoers.d/sparkdash-clock      (scoped NOPASSWD for ONE user)
#
# Account model (review item 3): no new login account is created. The
# dashboard already reaches the Spark over SSH as the operator's user; this
# grant lets exactly that one user run exactly this helper as root without a
# password. It is never `%sudo` and never `ALL ALL`, and it grants no other
# command.
#
# Argv pinning (review item 1):
#   - Each `--max-mhz` form is an anchored sudoers regular expression
#     (sudo >= 1.9.10) over the argument list —
#     `^--domain D --max-mhz [0-9]+ --persist$` —, so an empty value,
#     extra flags, or a different order never match. No glob is used in
#     the value slot: a sudoers glob `*` matches any text, including spaces.
#   - There is NO bare-binary entry (which sudoers would read as "any argv").
#     Availability is probed with the pinned, no-op `--check` form.
#
# The sudoers drop-in is validated with visudo -c BEFORE installation.
set -eu

HELLO_SRC="$(dirname "$0")/sparkdash-set-clock"
HELLO_DST=/usr/local/bin/sparkdash-set-clock
SUDOERS_DST=/etc/sudoers.d/sparkdash-clock
SSH_USER=${SPARKDASH_SSH_USER:-${SUDO_USER:-}}

[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)" >&2; exit 1; }
[ -n "$SSH_USER" ] || { echo "set SPARKDASH_SSH_USER to the dashboard's SSH user" >&2; exit 1; }
[ "$SSH_USER" != "root" ] || { echo "refusing to scope the grant to root" >&2; exit 1; }
id "$SSH_USER" >/dev/null 2>&1 || { echo "no such user: $SSH_USER" >&2; exit 1; }

# sudoers regex argv needs sudo >= 1.9.10.
SUDO_VER=$(sudo -V 2>/dev/null | sed -n '1s/^Sudo version \([0-9.]*\).*/\1/p')
case "$SUDO_VER" in
  1.[0-8].*|1.9.[0-9]|1.9.[0-9][!0-9]*|'')
    echo "sudo $SUDO_VER is too old for regex argv pinning (need >= 1.9.10)" >&2; exit 1 ;;
esac

# 1. Helper binary.
if [ -f "$HELLO_SRC" ]; then
  install -m 0755 "$HELLO_SRC" "$HELLO_DST"
else
  echo "helper source not found next to installer ($HELLO_SRC); aborting" >&2
  exit 1
fi

# 2. Scoped sudoers drop-in.
TMP=$(mktemp /tmp/sparkdash-clock.XXXXXX)
trap 'rm -f "$TMP"' EXIT
{
  echo "# Managed by sparkDash install-clock-helper.sh — scoped clock-control grant."
  echo "# User: $SSH_USER (the dashboard's SSH user). Remove this file to revoke."
  echo "# Every entry is a complete argv. No bare binary (= any argv) entry."
  echo "Cmnd_Alias SPARKDASH_CLOCK_CMDS = \\"
  echo "  $HELLO_DST --check, \\"
  for d in cpu-big cpu-little gpu; do
    echo "  $HELLO_DST --domain $d --unlock --persist, \\"
    echo "  $HELLO_DST --domain $d --unlock --no-persist, \\"
    echo "  $HELLO_DST ^--domain $d --max-mhz [0-9]+ --persist\$, \\"
    if [ "$d" = gpu ]; then
      echo "  $HELLO_DST ^--domain $d --max-mhz [0-9]+ --no-persist\$"
    else
      echo "  $HELLO_DST ^--domain $d --max-mhz [0-9]+ --no-persist\$, \\"
    fi
  done
  echo "$SSH_USER ALL=(root) NOPASSWD: SPARKDASH_CLOCK_CMDS"
} > "$TMP"

# Validate before installing; never leave a broken sudoers file behind.
visudo -c -f "$TMP" >/dev/null
install -m 0440 "$TMP" "$SUDOERS_DST"

echo "installed $HELLO_DST and $SUDOERS_DST (grant: $SSH_USER)"
echo "set this Spark's SSH user in sparkDash to: $SSH_USER"
echo "verify: ssh $SSH_USER@<host> 'sudo -n $HELLO_DST --domain gpu --unlock --no-persist'"
