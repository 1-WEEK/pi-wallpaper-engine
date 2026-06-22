import { useEffect, useMemo, useState } from "react"
import { isAdultContent } from "@pwe/shared"
import useSWR from "swr"
import { api, type DownloadStage, type DownloadTask } from "../api.js"
import { appIcons } from "../icons.js"
import { useLayout } from "../components/mobile/index.js"

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

const isAdultTask = (task: DownloadTask): boolean =>
  isAdultContent({
    title: task.title,
    contentRating: task.content_rating,
    ratingSex: task.rating_sex,
    adultHint: task.adult_hint,
  })

export const Downloads = () => {
  const [privacyOpen, setPrivacyOpen] = useState(false)
  const [showAdult, setShowAdult] = useState(false)
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
  const adultCount = useMemo(() => tasks.filter(isAdultTask).length, [tasks])
  const visibleTasks = useMemo(
    () => (showAdult ? tasks : tasks.filter((task) => !isAdultTask(task))),
    [tasks, showAdult]
  )
  const active = visibleTasks.filter((t) => !isFinished(t))
  const finished = visibleTasks.filter(isFinished)

  const dismiss = async (id: string) => {
    await api.dismissDownloadTask(id)
    mutate()
  }

  const cancel = async (id: string) => {
    await api.cancelDownload(id).catch(() => {
      // 404 is fine — the workflow may have already finished between render
      // and the click. The next SWR refresh will reflect the real terminal
      // state without surfacing a spurious error.
    })
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
          <div className="page-kicker mono library-kicker-row">
            <span>Async SteamCMD workflow</span>
            <button
              type="button"
              className={`library-secret-trigger ${privacyOpen ? "active" : ""}`}
              aria-label={privacyOpen ? "Hide privacy filter" : "Show privacy filter"}
              aria-expanded={privacyOpen}
              onClick={() => setPrivacyOpen((open) => !open)}
            >
              ••
            </button>
          </div>
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
        </div>
      </header>

      <div className={`library-privacy-shell ${privacyOpen ? "open" : ""}`}>
        <div className="library-privacy-panel">
          <div className="library-privacy-copy">
            <div className="library-privacy-title mono">safe queue</div>
            <div className="library-privacy-note">
              {adultCount > 0
                ? showAdult
                  ? "All queued and finished downloads are visible in this session."
                  : `${adultCount} mature download item${adultCount === 1 ? "" : "s"} hidden in this session.`
                : "No mature-marked downloads found."}
            </div>
          </div>
          <div className="segmented segmented-compact library-privacy-toggle">
            <button
              type="button"
              className={`segmented-button ${!showAdult ? "active" : ""}`}
              aria-pressed={!showAdult}
              onClick={() => setShowAdult(false)}
            >
              Safe
            </button>
            <button
              type="button"
              className={`segmented-button ${showAdult ? "active" : ""}`}
              aria-pressed={showAdult}
              onClick={() => setShowAdult(true)}
            >
              All
            </button>
          </div>
        </div>
      </div>

      {visibleTasks.length === 0 && (
        <div className="empty-state">
          {tasks.length > 0 && !showAdult && adultCount > 0
            ? "Downloads are hidden in safe mode. Open the secret filter to reveal them."
            : "No downloads yet. Pick a wallpaper in Browse."}
        </div>
      )}

      {active.length > 0 && (
        <section className="download-section">
          <h2 className="section-title mono">Active</h2>
          <ul className="download-list">
            {active.map((t) => (
              <DownloadRow key={t.workshop_id} task={t} onDismiss={dismiss} onCancel={cancel} />
            ))}
          </ul>
        </section>
      )}

      {finished.length > 0 && (
        <section className="download-section">
          <div className="download-section-header">
            <h2 className="section-title mono">Finished</h2>
            <button type="button" className="btn btn-secondary" onClick={dismissAllFinished} aria-label="Clear all finished downloads">
              {appIcons.close}
            </button>
          </div>
          <ul className="download-list download-list-finished">
            {finished.map((t) => (
              <DownloadRow key={t.workshop_id} task={t} onDismiss={dismiss} onCancel={cancel} />
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
  onCancel: (id: string) => void
}

const DownloadRow = ({ task, onDismiss, onCancel }: RowProps) => {
  const { mobile } = useLayout()
  const stageClass =
    task.stage === "error" ? "dl-stage-error" : task.stage === "complete" ? "dl-stage-ok" : ""

  const elapsedMs = (task.finished_at ?? Date.now()) - task.started_at
  const elapsed = formatElapsed(elapsedMs / 1000)

  const showBar = !isFinished(task)
  const determinate = task.percent !== null && task.percent !== undefined
  const percentClamped =
    determinate && task.percent !== null ? Math.max(0, Math.min(100, task.percent)) : 0

  // Mobile: stacked layout so status pill + Dismiss never overflow at 390px.
  if (mobile && isFinished(task)) {
    return (
      <li className="download-row-mobile">
        <div className="download-row-mobile-head">
          {task.preview_url ? (
            <img
              className="download-row-mobile-thumb"
              src={task.preview_url}
              alt={task.title}
              loading="lazy"
            />
          ) : (
            <div className="download-row-mobile-thumb" />
          )}
          <div className="download-row-mobile-copy">
            <div className="download-row-mobile-title">{task.title}</div>
            <div className="download-row-mobile-id mono">{task.workshop_id}</div>
          </div>
        </div>
        {task.stage === "error" && task.message && (
          <div className="download-row-mobile-error mono">{task.message}</div>
        )}
        <div className="download-row-mobile-foot">
          <span className={`status-pill ${stageClass}`}>{stageLabel[task.stage]}</span>
          <span className="mono" style={{ fontSize: 11, color: "var(--paper-faint)" }}>
            {elapsed}
          </span>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => onDismiss(task.workshop_id)}
          >
            Dismiss
          </button>
        </div>
      </li>
    )
  }

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
        {isFinished(task) ? (
          <button type="button" className="btn btn-secondary" onClick={() => onDismiss(task.workshop_id)}>
            Dismiss
          </button>
        ) : (
          <button type="button" className="btn btn-secondary" onClick={() => onCancel(task.workshop_id)}>
            Cancel
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
