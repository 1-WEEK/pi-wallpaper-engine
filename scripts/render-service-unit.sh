#!/usr/bin/env bash
# Render the pi-wallpaper-engine systemd unit.
#
# Kept out of install-pi.sh so the media-root ordering can be verified on its
# own (see the guard at the bottom) and so the escaped mount unit name — which
# contains backslashes — is never passed through sed.
#
# Usage: render-service-unit.sh <config.json> <template> <output>
#
# Ordering semantics, and why not `RequiresMountsFor=`:
#
# The service must not race the media-root mount at boot, but it must still
# start when that mount fails — the web UI is the only way an administrator can
# see and fix "the share is not mounted", and a `Requires=`-style dependency
# would take that UI down with the mount. So the unit gets `After=` (wait for a
# mount attempt that is already running) plus `Wants=` (start regardless of its
# outcome).
#
# Scope caveat, measured 2026-10-01: this renders into a *user* unit while the
# shelf mounts are *system* units, and the user manager cannot resolve a system
# unit name (`systemctl --user show systemd-journald.service` → not-found; the
# mount itself shows up only as `SourcePath=/proc/self/mountinfo` once it is
# already mounted). So while the share is still down — the boot window this is
# meant to cover — the name is unresolvable and the dependency is inert. The
# directive is emitted anyway because it is correct and becomes effective
# wherever the mount resolves in the same manager; the boot outcome is
# guaranteed by the runtime recovery in the backend, not by this ordering.
# See docs/agents/development.md § Media-root ordering.
#
# The mount unit name is derived from the configured media root, not hardcoded:
# `storage.root` when set, otherwise `paths.data_root`, escaped to a unit name
# by `systemd-escape` (the authority on the encoding) rather than by hand.

set -euo pipefail

CONFIG_PATH="${1:?config path required}"
TEMPLATE="${2:?template path required}"
OUTPUT="${3:?output path required}"

if [ ! -f "$CONFIG_PATH" ]; then
  echo "render-service-unit: config not found at $CONFIG_PATH" >&2
  exit 1
fi

MEDIA_ROOT="$(
  CONFIG_PATH="$CONFIG_PATH" bun -e "
    const fs = require('fs');
    const c = JSON.parse(fs.readFileSync(process.env.CONFIG_PATH, 'utf-8'));
    const root = c.storage && c.storage.root ? c.storage.root : c.paths.data_root;
    console.log(root.replace(/^~(?=\/|\$)/, process.env.HOME));
  "
)"
MEDIA_ROOT="${MEDIA_ROOT/#\~/$HOME}"

MOUNT_UNIT=""
if [ -n "$MEDIA_ROOT" ] && command -v systemd-escape >/dev/null 2>&1; then
  MOUNT_UNIT="$(systemd-escape -p --suffix=mount "$MEDIA_ROOT")"
fi

MOUNT_UNIT="$MOUNT_UNIT" TEMPLATE="$TEMPLATE" OUTPUT="$OUTPUT" bun -e "
  const fs = require('fs');
  const unit = process.env.MOUNT_UNIT;
  const ordering = unit ? \`After=\${unit}\nWants=\${unit}\` : '';
  const rendered = fs
    .readFileSync(process.env.TEMPLATE, 'utf-8')
    .replaceAll('@@PROJECT_ROOT@@', process.env.PROJECT_ROOT ?? '')
    .replaceAll('@@HOME@@', process.env.HOME ?? '')
    .replaceAll('@@BUN_BIN@@', process.env.BUN_BIN ?? '')
    .replaceAll('@@MOUNT_ORDERING@@', ordering);
  fs.writeFileSync(process.env.OUTPUT, rendered);
"

if [ -n "$MOUNT_UNIT" ]; then
  echo "$MOUNT_UNIT"
fi

# Guard: the rendered unit must express ordering *without* a hard requirement.
# `systemd-analyze verify` cannot run here (it resolves the whole dependency
# graph against the host, and the mount unit belongs to the shelf project), so
# the two properties the ticket actually cares about are asserted directly.
if grep -qi "RequiresMountsFor" "$OUTPUT"; then
  echo "render-service-unit: rendered unit must not use RequiresMountsFor (fails the service with the mount)" >&2
  exit 1
fi

if [ -n "$MOUNT_UNIT" ]; then
  grep -qxF "After=$MOUNT_UNIT" "$OUTPUT" || {
    echo "render-service-unit: expected 'After=$MOUNT_UNIT' in the rendered unit" >&2
    exit 1
  }
  grep -qxF "Wants=$MOUNT_UNIT" "$OUTPUT" || {
    echo "render-service-unit: expected 'Wants=$MOUNT_UNIT' in the rendered unit" >&2
    exit 1
  }
fi
