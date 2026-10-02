// The one play-limit control (ADR 0012): the PlayerBar popover, the mobile
// mini-player sheet and the Settings row all render these presets against the
// same stored value, so the surfaces cannot drift apart.
export const PLAY_LIMIT_OPTIONS = [
  { label: "OFF", minutes: 0 },
  { label: "15M", minutes: 15 },
  { label: "30M", minutes: 30 },
  { label: "1H", minutes: 60 },
  { label: "2H", minutes: 120 },
] as const

/** ONCE consumes the value when its session ends; ALWAYS re-arms every session. */
export const PLAY_LIMIT_MODES = [
  { label: "ONCE", once: true },
  { label: "ALWAYS", once: false },
] as const

/** Whole minutes left on an armed deadline, for the compact subtitles. */
export const playLimitMinutesLeft = (
  limit: { deadline: number | null } | null
): number | null =>
  limit?.deadline != null ? Math.max(0, Math.ceil((limit.deadline - Date.now()) / 60000)) : null
