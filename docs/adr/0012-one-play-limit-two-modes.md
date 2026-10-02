# ADR 0012: One play limit, set from the PlayerBar or Settings, with a one-shot mode

## Status

Accepted, 2026-10-02. Supersedes the sleep-timer half of ADR 0009 and the
two-timer arrangement recorded in ADR 0010.

## Context

ADR 0010 added the durable play limit but kept the older sleep timer beside it:
Settings owned the policy, the PlayerBar owned a one-shot instruction, and the
two had to disarm each other on elapse. The boundary was defensible on paper and
confusing in practice:

- Two controls of the same shape ("stop playback after N minutes") behaved
  differently depending on where they were found: one persisted, one did not.
- The bar's copy was the one actually reached for, and it vanished on restart,
  so "stop after 30 minutes" had to be re-set every evening.
- The race between the two timers existed only because both existed.

## Decision

Keep one play limit and give it a mode, edited from the PlayerBar popover, the
mobile mini-player sheet, and the Settings row:

- **ALWAYS** (the default): the value persists, is armed on every playback
  session, and survives restarts.
- **ONCE**: the value applies to one session. It is consumed when that session
  ends — elapse, explicit stop, or display-off — and a value still pending at
  boot is cleared, because the session it belonged to died with the process.

Setting a value while a session is running re-arms the deadline from now, in both
modes: every surface shows the same countdown, so a set has to mean "N minutes
from now". `next`/`prev`/pause still do not re-arm.

The sleep timer, `POST /api/player/sleep`, and the summary's `sleep` block are
removed; `play_limit` gains `once`, and the presets live in one place in the
frontend so the three surfaces cannot drift.

## Consequences

- One timer, one stored value, three entry points; no either-timer-wins race and
  no second shutdown path.
- The cost ADR 0010 avoided — a bar click silently becoming a permanent policy —
  is answered by the mode rather than by a second timer.
- `playback_prefs` gains `play_limit_once`, added in place for databases created
  before this change.
- A one-shot that is set and then abandoned (the process is killed before the
  session ends) is dropped at boot rather than firing against a later session.
- The PlayerBar's `sleep Nm` subtitle becomes `limit Nm`, and the mobile sheet's
  SLEEP row becomes PLAY LIMIT with the same presets as Settings.
