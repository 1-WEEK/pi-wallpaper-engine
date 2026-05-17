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
      <header className="page-header">
        <div>
          <div className="page-kicker mono">Async SteamCMD workflow</div>
          <h1 className="page-title">Downloads</h1>
        </div>
        <div className="page-actions">
          <div className="summary-stat compact">
            <span className="summary-stat-label mono">active</span>
            <strong>{active.length}</strong>
          </div>
          <div className="summary-stat compact">
            <span className="summary-stat-label mono">finished</span>
            <strong>{finished.length}</strong>
          </div>
          {finished.length > 0 && (
            <button type="button" className="btn btn-secondary" onClick={dismissAllFinished}>
              Clear finished
            </button>
          )}
        </div>
      </header>

      {tasks.length === 0 && <div className="empty-state">No downloads yet. Pick a wallpaper in Browse.</div>}

      {active.length > 0 && (
        <section className="download-section">
          <h2 className="section-title mono">Active</h2>
          <ul className="download-list">
            {active.map((t) => (
              <DownloadRow key={t.workshop_id} task={t} onDismiss={dismiss} />
            ))}
          </ul>
        </section>
      )}

      {finished.length > 0 && (
        <section className="download-section">
          <h2 className="section-title mono">Finished</h2>
          <ul className="download-list download-list-finished">
            {finished.map((t) => (
              <DownloadRow key={t.workshop_id} task={t} onDismiss={dismiss} />
            ))}
          </ul>
        </section>
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
    <li className={`download-row ${isFinished(task) ? "finished" : "active"}`}>
      <div className="download-thumb-wrap">
        {task.preview_url ? (
          <img className="download-thumb" src={task.preview_url} alt={task.title} loading="lazy" />
        ) : (
          <div className="download-thumb download-thumb-empty" />
        )}
      </div>
      <div className="download-copy">
        <div className="download-title-row">
          <div className="download-title">{task.title}</div>
          <span className={`status-pill ${stageClass}`}>
            {stageLabel[task.stage]}
          </span>
        </div>
        <div className="download-meta">
          <span className="mono">{task.workshop_id}</span>
          {determinate && <span className="download-pct mono">{percentClamped.toFixed(1)}%</span>}
          {task.bytes_total !== null && task.bytes_total !== undefined && task.bytes_total > 0 && (
            <span className="mono">
              {formatBytes(task.bytes_done ?? 0)} / {formatBytes(task.bytes_total)}
            </span>
          )}
          <span className="mono download-time">{elapsed}</span>
        </div>
        {showBar && (
          <div
            className={`card-progress card-progress-wide ${determinate ? "" : "indeterminate"}`}
            role="progressbar"
            aria-valuenow={determinate ? percentClamped : undefined}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="card-progress-fill"
              style={determinate ? { width: `${percentClamped}%` } : undefined}
            />
          </div>
        )}
        {task.stage === "error" && task.message && (
          <div className="download-message download-message-error">{task.message}</div>
        )}
      </div>
      <div className="download-actions">
        {isFinished(task) && (
          <button type="button" className="btn btn-secondary" onClick={() => onDismiss(task.workshop_id)}>
            Dismiss
          </button>
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
