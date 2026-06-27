# ADR 0007: Download Process Registry

## Status

Accepted, 2026-06-27.

## Context

SteamCMD downloads are long-running and are started by the backend as part of
download intake. While the backend process is alive, Effect release handling can
kill the spawned SteamCMD child on cancellation or shutdown.

After a backend restart, that in-memory child handle is gone. The existing
startup reconcile can mark unfinished `download_tasks` rows as interrupted and
clean orphan media, but it cannot identify or stop a SteamCMD process that
survived the backend restart. That leaves a dangerous split state: the UI shows
an interrupted download while SteamCMD may still be writing into `source/<id>/`.

## Decision

Introduce a Download process registry stored under the local application state
root, not under the media root.

The registry records the local SteamCMD process tied to one workshop download
intake. `SteamCmd.download()` registers the process after spawn and unregisters
it during release. Cancellation uses the registry to find and stop the process.

Registry entries are treated as live process pointers, not historical records.
Backend startup sweeps the registry:

- stale entries are removed,
- entries whose PID still points at the expected SteamCMD command are killed,
- interrupted task cleanup remains aligned with the visible
  `Interrupted by restart` state.

PID reuse must be guarded by command-line verification. If the PID file is
missing or stale, cancellation may fall back to scanning the process table for a
SteamCMD command matching the workshop id.

## Consequences

- Download cancellation can best-effort stop SteamCMD even after a backend
  restart.
- The media root does not need to be mounted or writable to inspect registry
  state.
- The registry does not become an audit log; task history remains in
  `download_tasks`.
- Implementation must include platform-aware process command-line inspection
  and tests for PID matching / stale entry cleanup.
