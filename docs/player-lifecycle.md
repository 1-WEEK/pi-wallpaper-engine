# Playback resources and rollback

The player is created when playback needs it. Stopping unloads the wallpaper
immediately and releases the mpv process after 30 seconds. Replaying during that
grace period reuses the process. Pause keeps the loaded wallpaper and playback
position alive.

Display-off saves restore intent, releases the player and waits for its child
process to exit, then runs the display command. If the display command fails,
the released player remains absent and the request reports the display error.
If process cleanup fails, the display command is not run; another attempt can
retry cleanup.

Display commands keep their 5-second execution deadline. Timeout or cancellation
terminates the owned child with SIGTERM, allows one second, then escalates to
SIGKILL with another one-second wait. Cancelling the stderr reader has a separate
one-second bound so an exited command’s descendant cannot keep controls or
shutdown waiting for EOF. This allows at most three additional seconds for
cleanup; unsuccessful termination or reader closure is logged. Failed commands
retain their existing DisplayError contract and do not change the cached state.

Display-on restores the saved wallpaper from the beginning with its library
picture mode. Success clears the saved intent. A deleted library item clears it;
an ordinary restore failure keeps it. Manual stop retains its existing
30-second display auto-off countdown. Another stop while already idle cancels
that countdown and clears the restore item.

Sleep expiry uses the same display-off path. When display-off fails, the existing
fallback calls the manual-stop path. After successful player release, that
fallback sees an idle player, clears restore intent and does not create another
process. Backend startup restores only when the display probe reports on;
startup restore does not automatically arm rotation. Explicit display-on restore
keeps its existing rotation linkage.

## Restore larger cache budgets

Set these optional `mpv` configuration fields and restart the backend:

```json
"cache_forward_mib": 150,
"cache_backward_mib": 50
```

This restores the former cache budgets independently of process lifecycle. The
32/8 MiB defaults and validation are documented in [README.md](../README.md).

## Restore the persistent player lifecycle

The display integration depends on the restartable player implementation. Revert
the display cleanup fix and both lifecycle implementation commits, in this
order, as one reviewed change:

```bash
git revert --no-commit 42184e4 555cb63 9bd846b
bun test
bun run typecheck
bun run build
```

`42184e4` adds bounded display subprocess ownership required by the masked
power-command ordering. `555cb63` adds immediate release to display linkage and scoped power/sleep
timers. `9bd846b` adds the restartable player and stopped-idle release. Commit the
validated combined revert before applying it to an installation. Keep the
separate cache configuration commit; choose either 32/8 or 150/50 MiB through
configuration. There is no lifecycle configuration toggle.

Restart the backend with `bun run service:restart` after an approved update (or
restart `bun run dev` in development). A backend restart interrupts current
playback. Future changes to these modules may need conflict resolution when
reverting; review the resulting behavior and validation before deployment.
