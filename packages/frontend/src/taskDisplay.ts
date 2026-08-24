import { isTerminalTaskStage, type ActivityTask } from "@pwe/shared"

// Shared display logic for the unified task model (downloads + transcodes).

export const DL_STAGE_LABEL: Record<string, string> = {
  starting: "Starting",
  downloading: "Downloading",
  finalizing: "Finalizing",
  done: "SteamCMD done",
  complete: "Complete",
  error: "Failed",
}

export const TRANSCODE_STAGE_LABEL: Record<string, string> = {
  pending: "Queued",
  claimed: "Queued",
  running: "Running",
  uploading: "Uploading",
  complete: "Completed",
  failed: "Failed",
}

export const taskStageLabel = (task: ActivityTask): string => {
  const labels = task.task_type === "download" ? DL_STAGE_LABEL : TRANSCODE_STAGE_LABEL
  return labels[task.stage] ?? task.stage
}

export const isTaskFinished = (t: ActivityTask): boolean =>
  isTerminalTaskStage(t.stage) || t.finished_at !== null

export const isTaskFailed = (t: ActivityTask): boolean =>
  t.stage === "error" || t.stage === "failed"
