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

The single play limit uses the same display-off path on expiry. When display-off fails, the existing
fallback calls the manual-stop path. After successful player release, that
fallback sees an idle player, clears restore intent and does not create another
process. Backend startup restores only when the display probe reports on;
startup restore does not automatically arm rotation. Explicit display-on restore
keeps its existing rotation linkage.

The durable play limit has permanent and one-shot modes. Explicit play and a
successful display-on restore arm it; pause, next, prev and rotation do not reset
the deadline. Updating the limit re-arms a running session. A one-shot value is
consumed at expiry, stop, display-off and boot; a permanent value remains saved.
The API is `POST /api/player/play-limit`, with `play_limit` in the system summary
([ADR 0012](adr/0012-one-play-limit-two-modes.md)). Timers belong to the service
scope and use the Effect clock. Playback intents serialize with expiry so an old
deadline cannot release a new session.

Media-root recovery retains the deployed distinction between automatic
`media_lost`/`startup` holds and deliberate `display_off`/`manual_stop`/`auto_off`
holds. End-file notifications converge status before announcing recovery while
retaining the selected media identity. The artifact commit lock also covers
player transitions; paused media remains occupied until unloaded or released.

## Restore larger cache budgets

Set these optional `mpv` configuration fields and restart the backend:

```json
"cache_forward_mib": 150,
"cache_backward_mib": 50
```

This restores the former cache budgets independently of process lifecycle. The
32/8 MiB defaults and validation are documented in [README.md](../README.md).

## Restore the persistent player lifecycle

This deployment integrates the memory changes onto the Pi's Effect 4 source
baseline `c717badd4818d12f9ed91ab1e646ddb68ec307aa`. The earlier Effect 3 lifecycle
commits are not a tested revert recipe for this tree.

To return to the complete previous deployment, restore the privately backed-up
source at that baseline together with its matching dependency lockfile and built
frontend, then use the guarded service restart. Preserve the current configuration
and databases unless the rollback specifically requires restoring them. The
deployment backup records their locations. A backend restart interrupts playback.

A lifecycle-only withdrawal while retaining the cache and observer changes needs
a prepared and reviewed patch against this Effect 4 baseline, with machine and Pi
validation under ticket 06. That independent rollback has not been verified.
There is no lifecycle configuration toggle. Cache-budget overrides above remain
independent of lifecycle and require only configuration and a backend restart.

Local machine gates and a deployment smoke check do not establish 24-hour memory
stability or complete the hardware acceptance and rollback tickets. The user chose
to deploy before that observation period; ticket 01 remains open.
