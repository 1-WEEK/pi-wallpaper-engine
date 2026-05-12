import { useEffect, useState } from "react"
import useSWR from "swr"
import { api, type DownloadStage, type DownloadTask } from "../api.js"

// Active downloads need a snappier refresh than the global SWR default; 1s
// matches the cadence SteamCMD emits stdout lines.
const REFRESH_MS = 1000

const stageLabel: Record<DownloadStage, string> = {
  starting: "Starting",
  downloading: "Downloading",
  finalizing: "Finalizing",
  done: "SteamCMD done",
  complete: "Complete",
  error: "Failed",
}

const formatElapsed = (totalSeconds: number): string => {
  const s = Math.max(0, Math.floor(totalSeconds))
  if (s >= 3600) {
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const sec = s % 60
    return `${h}:${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`
  }
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`
}

const isFinished = (t: DownloadTask) =>
  t.stage === "complete" || t.stage === "error" || t.finished_at !== null

export const Downloads = () => {
  const { data, error, mutate } = useSWR("download-tasks", api.downloadTasks, {
    refreshInterval: REFRESH_MS,
    revalidateIfStale: true,
    dedupingInterval: 0,
  })

  // Drive the per-row elapsed clock independently of SWR fetches so active
  // rows tick smoothly between fetches.
  const [, setTick] = useState(0)
  useEffect(() => {
    const h = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(h)
  }, [])

  const tasks = data ?? []
  const active = tasks.filter((t) => !isFinished(t))
  const finished = tasks.filter(isFinished)

  const dismiss = async (id: string) => {
    await api.dismissDownloadTask(id)
    mutate()
  }

  const dismissAllFinished = async () => {
    await Promise.all(finished.map((t) => api.dismissDownloadTask(t.workshop_id)))
    mutate()
  }

  if (error) return <div className="error">{(error as Error).message}</div>

  return (
    <div className="page">
      <div className="dl-header">
        <h2>Downloads</h2>
        {finished.length > 0 && (
          <button onClick={dismissAllFinished}>Clear finished ({finished.length})</button>
        )}
      </div>

      {tasks.length === 0 && (
        <div className="empty">No downloads. Pick a wallpaper in Browse.</div>
      )}

      {active.length > 0 && (
        <>
          <h3 className="dl-section">Active</h3>
          <ul className="dl-list">
            {active.map((t) => (
              <DownloadRow key={t.workshop_id} task={t} onDismiss={dismiss} />
            ))}
          </ul>
        </>
      )}

      {finished.length > 0 && (
        <>
          <h3 className="dl-section">Finished</h3>
          <ul className="dl-list">
            {finished.map((t) => (
              <DownloadRow key={t.workshop_id} task={t} onDismiss={dismiss} />
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

interface RowProps {
  task: DownloadTask
  onDismiss: (id: string) => void
}

const DownloadRow = ({ task, onDismiss }: RowProps) => {
  const stageClass =
    task.stage === "error" ? "dl-stage-error" : task.stage === "complete" ? "dl-stage-ok" : ""

  const elapsedMs = (task.finished_at ?? Date.now()) - task.started_at
  const elapsed = formatElapsed(elapsedMs / 1000)

  const showBar = !isFinished(task)
  const determinate = task.percent !== null && task.percent !== undefined
  const percentClamped =
    determinate && task.percent !== null ? Math.max(0, Math.min(100, task.percent)) : 0

  return (
    <li className="dl-row">
      <div className="dl-thumb-wrap">
        {task.preview_url ? (
          <img className="dl-thumb" src={task.preview_url} alt={task.title} loading="lazy" />
        ) : (
          <div className="dl-thumb dl-thumb-empty" />
        )}
      </div>
      <div className="dl-info">
        <div className="dl-title">{task.title}</div>
        <div className="dl-meta">
          <span className={`tag ${stageClass}`}>{stageLabel[task.stage]}</span>
          {determinate && <span className="dl-pct">{percentClamped.toFixed(1)}%</span>}
          {task.bytes_total !== null && task.bytes_total !== undefined && task.bytes_total > 0 && (
            <span className="dl-bytes">
              {formatBytes(task.bytes_done ?? 0)} / {formatBytes(task.bytes_total)}
            </span>
          )}
          <span className="dl-time">{elapsed}</span>
        </div>
        {showBar && (
          <div
            className={`dl-bar ${determinate ? "" : "dl-bar-indeterminate"}`}
            role="progressbar"
            aria-valuenow={determinate ? percentClamped : undefined}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="dl-bar-fill"
              style={determinate ? { width: `${percentClamped}%` } : undefined}
            />
          </div>
        )}
        {task.stage === "error" && task.message && (
          <div className="dl-message dl-message-error">{task.message}</div>
        )}
      </div>
      <div className="dl-actions">
        {isFinished(task) && (
          <button onClick={() => onDismiss(task.workshop_id)}>Dismiss</button>
        )}
      </div>
    </li>
  )
}

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
