import { useEffect, useMemo, useState } from "react"
import { isAdultContent, type LibraryItem, type TranscodeProgressEvent } from "@pwe/shared"
import useSWR, { useSWRConfig } from "swr"
import { api, type DownloadStage, type DownloadTask } from "../api.js"
import { appIcons } from "../icons.js"
import { formatBytes } from "../format.js"
import { useLayout } from "../components/mobile/index.js"

// Active downloads need a snappier refresh than the global SWR default; 1s
// matches the cadence SteamCMD emits stdout lines.
const REFRESH_MS = 1000

const dlStageLabel: Record<DownloadStage, string> = {
  starting: "Starting",
  downloading: "Downloading",
  finalizing: "Finalizing",
  done: "SteamCMD done",
  complete: "Complete",
  error: "Failed",
}

const transcodeStatusLabel: Record<string, string> = {
  skipped: "Skipped",
  pending: "Queued",
  claimed: "Queued",
  running: "Running",
  uploading: "Uploading",
  completed: "Completed",
  failed: "Failed",
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

const isDlFinished = (t: DownloadTask) =>
  t.stage === "complete" || t.stage === "error" || t.finished_at !== null

const isAdultDl = (task: DownloadTask): boolean =>
  isAdultContent({
    title: task.title,
    contentRating: task.content_rating,
    ratingSex: task.rating_sex,
    adultHint: task.adult_hint,
  })

const isAdultTc = (row: LibraryItem): boolean =>
  isAdultContent({
    title: row.title,
    contentRating: row.content_rating,
    ratingSex: row.rating_sex,
  })

export const Activity = () => {
  const [privacyOpen, setPrivacyOpen] = useState(false)
  const [showAdult, setShowAdult] = useState(false)

  const { data: dData, error: dError, mutate: dMutate } = useSWR("download-tasks", api.downloadTasks, {
    refreshInterval: REFRESH_MS,
    revalidateIfStale: true,
    dedupingInterval: 0,
  })

  const { data: tData, error: tError, mutate: tMutate } = useSWR("library-transcode", api.libraryList)
  
  const { data: summary } = useSWR("system-summary", api.systemSummary)

  // Drive the per-row elapsed clock independently of SWR fetches so active
  // rows tick smoothly between fetches.
  const [, setTick] = useState(0)
  useEffect(() => {
    const h = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(h)
  }, [])

  // Transcode WebSocket connection
  const shouldConnectWS = useMemo(() => {
    if (!summary?.status.transcode) return false
    const tc = summary.status.transcode
    const nonSkippedCount = tc.pending + tc.claimed + tc.running + tc.uploading + tc.completed + tc.failed
    return nonSkippedCount > 0
  }, [summary])

  useEffect(() => {
    if (!shouldConnectWS) return
    let ws = api.libraryTranscodeWatchWS()
    
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as TranscodeProgressEvent
        tMutate(
          (current?: LibraryItem[]) => {
            if (!current) return current
            return current.map(item => {
              if (item.workshop_id === msg.workshopId) {
                return {
                  ...item,
                  transcode_status: msg.status,
                  ...(msg.progress !== undefined ? { transcode_progress: msg.progress } : {}),
                  ...(msg.error !== undefined ? { transcode_error: msg.error } : {}),
                  ...(msg.status === "completed" ? { transcode_progress: 100 } : {})
                }
              }
              return item
            })
          },
          { revalidate: false }
        )
        if (msg.status === "completed" || msg.status === "failed") {
          tMutate() // fully fetch to get output size etc
        }
      } catch (err) {
        console.error("Transcode WS parse error", err)
      }
    }
    
    return () => ws.close()
  }, [tMutate, shouldConnectWS])

  const dlTasks = dData ?? []
  const tcTasks = (tData ?? []).filter(t => t.transcode_status && t.transcode_status !== "skipped" && t.transcode_status !== "completed")

  const adultDlCount = useMemo(() => dlTasks.filter(isAdultDl).length, [dlTasks])
  const adultTcCount = useMemo(() => tcTasks.filter(isAdultTc).length, [tcTasks])
  const adultCount = adultDlCount + adultTcCount

  const visibleDlTasks = useMemo(
    () => (showAdult ? dlTasks : dlTasks.filter((t) => !isAdultDl(t))),
    [dlTasks, showAdult]
  )
  const visibleTcTasks = useMemo(
    () => (showAdult ? tcTasks : tcTasks.filter((t) => !isAdultTc(t))),
    [tcTasks, showAdult]
  )

  const activeDl = visibleDlTasks.filter((t) => !isDlFinished(t))
  const finishedDl = visibleDlTasks.filter(isDlFinished)

  const activeTc = visibleTcTasks.filter(t => t.transcode_status === "running" || t.transcode_status === "uploading" || t.transcode_status === "claimed")
  const queuedTc = visibleTcTasks.filter(t => t.transcode_status === "pending" || t.transcode_status === "failed")

  const hasFailedTc = queuedTc.some(t => t.transcode_status === "failed")
  const [isRetryingAll, setIsRetryingAll] = useState(false)

  const handleRetryAllTc = async () => {
    setIsRetryingAll(true)
    try {
      await api.libraryTranscodeRetryAll()
      await tMutate()
    } catch (err) {
      console.error(err)
    } finally {
      setIsRetryingAll(false)
    }
  }

  const dismissDl = async (id: string) => {
    await api.dismissDownloadTask(id)
    dMutate()
  }

  const cancelDl = async (id: string) => {
    await api.cancelDownload(id).catch(() => {})
    dMutate()
  }

  const retryDl = async (id: string) => {
    await api.download(id).catch(() => {})
    dMutate()
  }

  const dismissAllFinishedDl = async () => {
    await Promise.all(finishedDl.map((t) => api.dismissDownloadTask(t.workshop_id)))
    dMutate()
  }

  const combinedError = dError || tError

  if (combinedError) return <div className="error">{(combinedError as Error).message}</div>

  const isLiveMode = shouldConnectWS

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1 className="page-title">Activity</h1>
        </div>
        <div className="page-actions">
          <div className="summary-stat compact">
            <span className="summary-stat-label mono">active</span>
            <strong>{activeDl.length + activeTc.length}</strong>
          </div>
          <div className="summary-stat compact">
            <span className="summary-stat-label mono">finished</span>
            <strong>{finishedDl.length}</strong>
          </div>
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
      </header>

      <div className={`library-privacy-shell ${privacyOpen ? "open" : ""}`}>
        <div className="library-privacy-panel">
          <div className="library-privacy-copy">
            <div className="library-privacy-title mono">safe queue</div>
            <div className="library-privacy-note">
              {adultCount > 0
                ? showAdult
                  ? "All queued and finished tasks are visible in this session."
                  : `${adultCount} mature task${adultCount === 1 ? "" : "s"} hidden in this session.`
                : "No mature-marked tasks found."}
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

      {visibleDlTasks.length === 0 && visibleTcTasks.length === 0 && (
        <div className="empty-state">
          {dlTasks.length + tcTasks.length > 0 && !showAdult && adultCount > 0
            ? "Tasks are hidden in safe mode. Open the secret filter to reveal them."
            : "No active tasks. Pick a wallpaper in Browse."}
        </div>
      )}

      {(activeDl.length > 0 || activeTc.length > 0) && (
        <section className="task-section">
          <h2 className="section-title mono">Active</h2>
          <ul className="task-list">
            {activeDl.map((t) => (
              <DownloadRow key={`dl-${t.workshop_id}`} task={t} onDismiss={dismissDl} onCancel={cancelDl} onRetry={retryDl} />
            ))}
            {activeTc.map((t) => (
              <TranscodeRow key={`tc-${t.workshop_id}`} task={t} />
            ))}
          </ul>
        </section>
      )}

      {finishedDl.length > 0 && (
        <section className="task-section">
          <div className="task-section-header">
            <h2 className="section-title mono">Finished Downloads</h2>
            <button type="button" className="btn btn-secondary" onClick={dismissAllFinishedDl} aria-label="Clear all finished downloads">
              {appIcons.close}
            </button>
          </div>
          <ul className="task-list">
            {finishedDl.map((t) => (
              <DownloadRow key={`dl-${t.workshop_id}`} task={t} onDismiss={dismissDl} onCancel={cancelDl} onRetry={retryDl} />
            ))}
          </ul>
        </section>
      )}

      {queuedTc.length > 0 && (
        <section className="task-section">
          <div className="task-section-header">
            <h2 className="section-title mono">Transcode Queue</h2>
            {hasFailedTc && (
              <button
                className="btn btn-secondary"
                onClick={handleRetryAllTc}
                disabled={isRetryingAll}
              >
                {isRetryingAll ? "Retrying..." : "Retry All Failed"}
              </button>
            )}
          </div>
          <ul className="task-list">
            {queuedTc.map((t) => (
              <TranscodeRow key={`tc-${t.workshop_id}`} task={t} />
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

interface DlRowProps {
  task: DownloadTask
  onDismiss: (id: string) => void
  onCancel: (id: string) => void
  onRetry: (id: string) => void
}

const DownloadRow = ({ task, onDismiss, onCancel, onRetry }: DlRowProps) => {
  const { mobile } = useLayout()
  const stageClass =
    task.stage === "error" ? "dl-stage-error" : task.stage === "complete" ? "dl-stage-ok" : ""

  const elapsedMs = (task.finished_at ?? Date.now()) - task.started_at
  const elapsed = formatElapsed(elapsedMs / 1000)

  const showBar = !isDlFinished(task)
  const determinate = task.percent !== null && task.percent !== undefined
  const percentClamped =
    determinate && task.percent !== null ? Math.max(0, Math.min(100, task.percent)) : 0

  if (mobile && isDlFinished(task)) {
    return (
      <li className="task-row-mobile">
        <div className="task-row-mobile-head">
          {task.preview_url ? (
            <img
              className="task-row-mobile-thumb"
              src={task.preview_url}
              alt={task.title}
              loading="lazy"
            />
          ) : (
            <div className="task-row-mobile-thumb" />
          )}
          <div className="task-row-mobile-copy">
            <div className="task-row-mobile-title">{task.title}</div>
            <div className="task-row-mobile-id mono">{task.workshop_id}</div>
          </div>
        </div>
        {task.stage === "error" && task.message && (
          <div className="task-row-mobile-error mono">{task.message}</div>
        )}
        <div className="task-row-mobile-foot">
          <span className={`status-pill ${stageClass}`}>{dlStageLabel[task.stage]}</span>
          <span className="mono" style={{ fontSize: 11, color: "var(--paper-faint)" }}>
            {elapsed}
          </span>
          {task.stage === "error" && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => onRetry(task.workshop_id)}
            >
              Retry
            </button>
          )}
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
    <li className="task-row">
      <div className="task-thumb-wrap">
        {task.preview_url ? (
          <img className="task-thumb" src={task.preview_url} alt={task.title} loading="lazy" />
        ) : (
          <div className="task-thumb task-thumb-empty" />
        )}
      </div>
      <div className="task-copy">
        <div className="task-title-row">
          <div className="task-title">{task.title}</div>
          <span className={`status-pill ${stageClass}`}>
            {dlStageLabel[task.stage]}
          </span>
        </div>
        <div className="task-meta">
          <span className="mono">{task.workshop_id}</span>
          {determinate && <span className="task-pct mono">{percentClamped.toFixed(1)}%</span>}
          {task.bytes_total !== null && task.bytes_total !== undefined && task.bytes_total > 0 && (
            <span className="mono">
              {formatBytes(task.bytes_done ?? 0)} / {formatBytes(task.bytes_total)}
            </span>
          )}
          <span className="mono task-time">{elapsed}</span>
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
          <div className="task-message task-message-error">{task.message}</div>
        )}
      </div>
      <div className="task-actions">
        {isDlFinished(task) ? (
          <>
            {task.stage === "error" && (
              <button type="button" className="btn btn-secondary" onClick={() => onRetry(task.workshop_id)} style={{ marginRight: 8 }}>
                Retry
              </button>
            )}
            <button type="button" className="btn btn-secondary" onClick={() => onDismiss(task.workshop_id)}>
              Dismiss
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-secondary" onClick={() => onCancel(task.workshop_id)}>
            Cancel
          </button>
        )}
      </div>
    </li>
  )
}

const TranscodeRow = ({ task }: { task: LibraryItem }) => {
  const { mutate } = useSWRConfig()
  const [isRetrying, setIsRetrying] = useState(false)

  const status = task.transcode_status
  const isRunning = status === "running" || status === "uploading"
  const isFailed = status === "failed"

  let statusClass = "status-pill-pending"
  if (isRunning) statusClass = "status-pill-running"
  if (isFailed) statusClass = "status-pill-failed"

  const handleRetry = async () => {
    setIsRetrying(true)
    try {
      await api.libraryTranscode(task.workshop_id)
      await mutate("library-transcode")
    } catch (err) {
      console.error(err)
    } finally {
      setIsRetrying(false)
    }
  }

  const determinate = task.transcode_progress !== null && task.transcode_progress !== undefined

  return (
    <li className="task-row">
      <div className="task-thumb-wrap">
        {task.preview_url ? (
          <img className="task-thumb" src={task.preview_url} alt={task.title} loading="lazy" />
        ) : (
          <div className="task-thumb task-thumb-empty" />
        )}
      </div>
      <div className="task-copy">
        <div className="task-title-row">
          <div className="task-title">{task.title}</div>
          <span className={`status-pill ${statusClass}`}>
            {transcodeStatusLabel[status]}
          </span>
        </div>
        <div className="task-meta">
          <span className="mono">{task.workshop_id}</span>
          <span className="mono task-info-pill">
            {task.source_resolution} • {task.source_codec}
          </span>
          <span className="mono task-info-pill">
            {task.source_size ? formatBytes(task.source_size) : "Unknown size"}
          </span>
        </div>
        {isRunning && determinate && (
          <div
            className={`card-progress card-progress-wide`}
            role="progressbar"
            aria-valuenow={task.transcode_progress ?? 0}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="card-progress-fill"
              style={{ width: `${task.transcode_progress}%` }}
            />
          </div>
        )}
        {isFailed && task.transcode_error && (
          <div className="task-message task-message-error">{task.transcode_error}</div>
        )}
      </div>
      <div className="task-actions">
        {isFailed && (
          <button
            className="btn btn-secondary"
            onClick={handleRetry}
            disabled={isRetrying}
          >
            {isRetrying ? "..." : "Retry"}
          </button>
        )}
      </div>
    </li>
  )
}
