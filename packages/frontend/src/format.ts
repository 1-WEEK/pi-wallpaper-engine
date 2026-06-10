import type { LibraryItem } from "@pwe/shared"

// Sleep-timer countdown as mm:ss, clamped at zero.
export const formatSleepCountdown = (ms: number): string => {
  const sec = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${String(s).padStart(2, "0")}`
}

// Percent saved versus source, or null when the row has no optimized result
// yet (or transcode somehow grew the file).
export const spaceSavedPercent = (row: LibraryItem): number | null => {
  if (row.transcode_status !== "completed") return null
  const source = row.source_size
  const optimized = row.transcoded_size
  if (!source || !optimized || optimized >= source) return null
  return Math.round(((source - optimized) / source) * 100)
}
