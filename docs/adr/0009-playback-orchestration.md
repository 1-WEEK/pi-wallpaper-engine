# ADR 0009: Playback orchestration lives in a dedicated module

## Status

Accepted, 2026-07-05.

## Context

The playback-coordination recipe — "disarm rotation before any stop-ish intent,
arm rotation after an explicit play" — belonged to no module. It was enforced by
call-site discipline at four places:

- `routes/player.ts:45-47` — play calls `PlayerPower.play()` then best-effort
  `Rotation.arm()`.
- `routes/player.ts:81-82` — stop calls `Rotation.disarm()` then
  `PlayerPower.stopForIdle()`.
- `routes/display.ts:50-52` — display off calls `Rotation.disarm()` then
  `PlayerPower.displayOff()`.
- `SleepTimer.ts:47-50` — sleep elapse calls `Rotation.disarm()` then
  `PlayerPower.displayOff()` with a `stopForIdle()` fallback.

Meanwhile `PlayerPower.restoreSaved()` (display-on and startup restore) plays a
wallpaper without touching rotation at all — a fourth, divergent variant of the
same concept. Three timers (PlayerPower auto-off, sleep, rotation interval)
lived in three modules with their mutual exclusion documented nowhere and
testable only by booting each caller separately. Every new playback entry point
had to remember the linkage by hand.

Architecture review of 2026-07-05 flagged this as candidate 1 (Strong, top
recommendation).

## Decision

Introduce a `Playback` Effect service
(`packages/backend/src/services/Playback.ts`) that owns playback orchestration.

**Interface (intent verbs only):** `play(workshopId)`, `stop()`, `displayOn()`,
`displayOff()`, `next()`, `prev()`, `setMode(mode)`,
`setRotationInterval(sec)`, `sleep(minutes)`, `sleepStatus()`.

- **SleepTimer is absorbed and deleted.** Its only substance was the elapse
  recipe, which is exactly the coordination `Playback` owns. `sleep(minutes)`
  keeps the `minutes<=0` cancel semantics and the `SleepStatus` shape; the
  system summary's `sleep:{active,deadline}` JSON is unchanged (BL-2 frozen
  contract).
- **`Rotation` and `PlayerPower` are kept unchanged but demoted to internal
  seams**: after this change only `Playback` consumes them. Their own tests
  remain the test surface for sequence semantics (ADR 0004) and display linkage
  (ADR 0003).
- **Routes keep direct access to pure verbs only**: pause/resume/display-mode/
  status stay on `Mpv`, display status stays on `Display`. Wrapping them would
  be shallow pass-through padding. Routes must not import `Rotation`,
  `PlayerPower`, or the deleted `SleepTimer`.
- **Layer placement**: `PlaybackLive` takes `SleepTimerLive`'s slot in
  `runtime.ts` (above `Rotation`/`PlayerPower`, which SleepTimer already proved
  viable).
- **Behavior-preserving**: every route-visible result, error mapping, and
  ordering is mirrored exactly; acceptance is the machine gate (ADR 0005).

**Follow-up resolved (signed off 2026-07-06):** display-on restore now re-arms
rotation on the restored wallpaper. `PlayerPower.displayOn()` reports the
restored workshop id as an internal fact (`restored_workshop_id`), and
`Playback.displayOn()` arms rotation with it best-effort, stripping the field
before the result reaches HTTP — the response body is unchanged. Arming
respects `play_mode` as usual (`Rotation.arm` no-ops in `single`).

**Still preserved:** startup restore (inside `PlayerPower`'s forkScoped boot
effect) does NOT re-arm rotation — after a backend restart the restored
wallpaper loops until the next explicit play or display-on. Changing that would
mean moving startup restore into `Playback`; it remains an open follow-up
requiring human sign-off.

## Consequences

- The coordination invariants ("disarm strictly before stop", "arm after play,
  best-effort", "auto-off pending implies rotation disarmed") become structural
  and unit-testable at one interface instead of once per caller.
- `routes/player.ts` and `routes/display.ts` drop to thin HTTP adapters; new
  playback entry points cannot forget the linkage.
- `SleepTimer.test.ts` behaviors migrate into `Playback.test.ts`;
  `routes/display.test.ts` mocks switch to `Playback` with unchanged contract
  assertions.
- The timer interplay gains a single coordination point: sleep lives in
  `Playback`, auto-off stays internal to `PlayerPower`, rotation's interval
  stays internal to `Rotation` — but all paths that start or stop them now flow
  through one module.
