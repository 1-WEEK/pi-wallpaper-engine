# Plan — Player And Display Linkage

Status: implemented 2026-05-24.

## Goal

Display power should follow the actual resource-saving intent. Turning the
display off should stop mpv decoding work, while turning it back on should be
able to restore the last wallpaper that was stopped for power saving.

## Final Behavior

- User `/api/player/stop` records the current wallpaper as restorable, stops
  mpv, and starts a 30-second auto-off timer.
- If the timer fires, the backend calls `display.off()`.
- User `/api/display/off` cancels any pending timer, records the current
  wallpaper when one is active, calls `mpv.stop()`, then calls `display.off()`.
- User `/api/display/on` calls `display.on()` first, then tries to restore the
  saved wallpaper from the beginning.
- User `/api/player/play/:workshopId` cancels any pending auto-off, clears
  restore state, and powers the display on first when the display is known to be
  off.
- Restore success clears the saved state.
- Restore failure leaves the display on, logs a warning, and keeps the saved
  state for the next attempt.
- If the saved wallpaper has been deleted, the backend silently clears the saved
  state and only turns the display on.
- `pause` does not participate in display power saving.

## Persistence

The backend stores restore intent in a singleton `player_state` table:

```sql
CREATE TABLE IF NOT EXISTS player_state (
  id                  TEXT PRIMARY KEY CHECK (id = 'singleton'),
  restore_workshop_id TEXT NOT NULL,
  restore_reason      TEXT NOT NULL,
  updated_at          INTEGER NOT NULL
);
```

This table records intent, not playback position. Restores always start the
wallpaper from the beginning, which is acceptable for looping wallpaper video.

## Startup Restore

Backend startup may restore automatically only when `display.status_command`
reports `on` with a probed status. Cached/default display state is ignored.

The user's deployment has a reliable `display.status_command`, so startup
restore is enabled by that runtime condition.

## Implementation

- `PlayerState` service owns the singleton restore row.
- `PlayerPower` service coordinates `Mpv`, `Display`, `Library`, and
  `PlayerState`.
- `/api/player/play` cancels pending auto-off, clears restore state, and
  best-effort powers on the display before calling mpv when display status is
  known `off`.
- `/api/player/stop` delegates to `PlayerPower.stopForIdle()`.
- `/api/display/on` and `/api/display/off` delegate to `PlayerPower`.

## Verification

Automated:

- `bun test packages/backend/src/services/PlayerPower.test.ts packages/backend/src/services/PlayerState.test.ts`
- `bun x tsc --noEmit` from `packages/backend`

Manual on Pi:

1. Play a wallpaper, click Stop, wait 30 seconds: display turns off.
2. Click Display On: display turns on and the stopped wallpaper starts from the beginning.
3. Play a wallpaper, click Display Off: mpv stops first, display turns off.
4. Click Display On: wallpaper restores.
5. With the display off, click Play on any wallpaper: display turns on and the
   selected wallpaper starts.
6. Delete the saved wallpaper before Display On: display turns on and restore state clears without user-visible error.
7. Restart backend while display is on and restore state exists: wallpaper restores automatically.
