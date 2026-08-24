export const ACTIVE_TRANSCODE_JOB_STATUSES = ["claimed", "running", "uploading"] as const

export const activeTranscodeStatusesSql = (column = "status"): string =>
  `${column} IN (${ACTIVE_TRANSCODE_JOB_STATUSES.map(() => "?").join(",")})`
