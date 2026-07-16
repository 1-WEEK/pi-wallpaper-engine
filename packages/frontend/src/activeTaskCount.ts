import type { SystemSummary } from "@pwe/shared"

export const getActiveTaskCount = (summary: SystemSummary | null | undefined): number => {
  if (!summary) return 0
  const dlActive = summary.status.downloads.active || 0
  let tcActive = 0
  if (summary.status.transcode) {
    tcActive =
      summary.status.transcode.running +
      summary.status.transcode.uploading +
      summary.status.transcode.claimed
  }
  return dlActive + tcActive
}
