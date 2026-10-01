# ADR 0010: Play limit is a session-scoped policy owned by Playback

## Status

Accepted, 2026-10-01.

## Context

The device is usually left running unattended. The administrator wanted the TV to
turn itself off after a bounded amount of playback instead of running all night,
and to be able to set that bound from Settings.

Two existing timers looked relevant but are the wrong shape:

- The **sleep timer** (ADR 0003) is a one-shot instruction from the PlayerBar: it
  arms once, fires, and is gone. It is not persisted and does not survive a
  restart — correct for "turn the screen off in 30 minutes", wrong for a policy.
- **Rotation** (ADR 0004) fires an interval timer that calls mpv directly. It
  never re-enters `Playback`, so it can neither own the deadline nor observe
  ordinary playback stops.

A policy needs durable storage, a restart-safe value, and a deadline that means
"this playback session", not "this wallpaper". The last point is the trap: if
every rotation tick re-armed the deadline, the limit would be pushed out forever
and never fire.

## Decision

Add a **play limit** as a durable preference owned by
`PlaybackPrefs` (`play_limit_minutes`, `0` = off) and *armed* by `Playback`, the
module ADR 0009 already made the single owner of playback orchestration.

- **Session-scoped arming.** `Playback.play()` and `displayOn()`-with-restore arm
  the deadline; `next`, `prev`, and pause deliberately do **not**. Rotation
  ticks are free — `Rotation` calls mpv directly and never re-enters `Playback`,
  so an armed limit simply counts down through them.
- **Stop reuses the existing recipe.** The elapse calls the same
  "disarm rotation, then display off with a `stopForIdle` fallback" path the
  sleep timer uses, factored into one `stopPlayback` effect. No second shutdown
  path is introduced.
- **Either timer wins, and disarms the other.** Both timers share a deadline
  counter; whichever elapses first ends the session and clears the other. Without
  this, a session that stopped could still report a live deadline and the summary
  would contradict itself. An explicit `stop()`/`displayOff()` clears both too.
- **The setting is separate from the live deadline in the API.** The system
  summary's `play_limit` carries `{ minutes, deadline }`: the stored policy and
  the active session's epoch-ms auto-stop (or `null`). The UI never recomputes the
  policy from the deadline.
- **Turning it off clears a live deadline.** `setPlayLimit(0)` disarms so "off"
  cannot strand a deadline in the summary; changing it while a session runs keeps
  the in-flight deadline (the UI is already counting it down).

Settings owns the *policy* control (an immediate-commit row in the Playback
section). The PlayerBar keeps the one-shot sleep timer. The boundary is "durable
versus this session", not "settings versus player", which is why the two do not
duplicate each other.

## Consequences

- The `playback_prefs` singleton gains a `play_limit_minutes` column;
  `DbLive.ensurePlaybackPrefsColumns` adds it in place for databases created
  before this change (`CREATE TABLE IF NOT EXISTS` will not touch an existing
  table).
- A new `POST /api/player/play-limit` route and a `play_limit` block in the
  system summary are the only API surface.
- `Playback` gains one more timer beside the sleep timer, and the two are the
  only mutually-aware timers; `PlayerPower`'s internal auto-off stays separate.
- Restart behavior is: the policy persists, but nothing auto-plays, so no
  deadline is armed until the next play — a limit can never fire on a stopped
  session.
