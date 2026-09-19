#!/usr/bin/env bash

set -euo pipefail

STEAMCMD_ROOT="${STEAMCMD_ROOT:-${HOME}/.local/share/steamcmd}"
cd "$STEAMCMD_ROOT" || exit 1

# Valve's launcher selects linuxarm64 on aarch64, but the official tarball
# ships the x86 SteamCMD binary under linux32 for box86 to translate.
export STEAM_PLATFORM=linux32
export DEBUGGER=box86
exec ./steamcmd.sh "$@"
