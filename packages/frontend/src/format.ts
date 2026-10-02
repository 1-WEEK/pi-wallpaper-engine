import type { LibraryItem } from "@pwe/shared"

// Play-limit countdown as h:mm:ss past an hour, else mm:ss, clamped at zero.
// The limit is minute-granular but can be tens of hours away, so a plain
// mm:ss reads wrong once the remaining time exceeds 99 minutes.
export const formatPlayLimitCountdown = (sec: number): string => {
  const total = Math.max(0, Math.floor(sec))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m)
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`
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

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
