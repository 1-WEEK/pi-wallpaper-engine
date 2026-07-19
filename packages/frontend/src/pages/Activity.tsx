import { useEffect, useMemo, useRef, useState } from "react"
import { isAdultContent } from "@pwe/shared"
import useSWR from "swr"
import useSWRInfinite from "swr/infinite"
import { api, type ActivityTask, type PaginatedTasks } from "../api.js"
import { formatBytes } from "../format.js"
import { isTaskFailed, isTaskFinished, taskStageLabel } from "../taskDisplay.js"
import { useLayout } from "../components/mobile/index.js"

const REFRESH_MS = 1000
const PAGE_SIZE = 50

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

const isAdultTask = (task: ActivityTask): boolean =>
  isAdultContent({
    title: task.title,
    contentRating: task.content_rating,
    ratingSex: task.rating_sex,
    adultHint: task.adult_hint,
  })

export const Activity = () => {
  const [privacyOpen, setPrivacyOpen] = useState(false)
  const [showAdult, setShowAdult] = useState(false)

  const getDlKey = (pageIndex: number, previousPageData: PaginatedTasks | null) => {
    if (previousPageData && !previousPageData.items.length) return null
    return ["tasks", pageIndex * PAGE_SIZE, PAGE_SIZE] as const
  }
  const fetcher = ([_, offset, limit]: readonly [string, number, number]) => api.tasks({ offset, limit })

  const { data: dData, error: dError, mutate: dMutate, size: dSize, setSize: setDSize } = useSWRInfinite(getDlKey, fetcher, {
    revalidateIfStale: true,
  })

  // Only the active set polls continuously; history pages are fetched on
  // demand so finished rows never shift under the user.
  const { data: activePageData, error: activeError, mutate: activeMutate } = useSWR(
    "active-tasks",
    () => api.tasks({ active: true, limit: PAGE_SIZE }),
    { refreshInterval: REFRESH_MS }
  )

  // When a task leaves the active set it just reached a terminal stage (or
  // was dismissed) — revalidate the static history pages once to pick it up.
  const prevActiveIds = useRef<ReadonlySet<string>>(new Set())
  useEffect(() => {
    const ids = new Set((activePageData?.items ?? []).map((t) => t.task_id))
    const prev = prevActiveIds.current
    prevActiveIds.current = ids
    if ([...prev].some((id) => !ids.has(id))) dMutate()
  }, [activePageData, dMutate])

  const [, setTick] = useState(0)
  useEffect(() => {
    const h = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(h)
  }, [])

  // iOS Safari aborts in-flight fetches when the page is backgrounded, and
  // SWR's resume-time focus revalidation can dedupe into that dying request,
  // leaving the history hook stuck on an AbortError. mutate() bypasses
  // deduping, so force a clean revalidation when we return to the foreground.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return
      dMutate()
      activeMutate()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => document.removeEventListener("visibilitychange", onVisible)
  }, [dMutate, activeMutate])

  const allTasks = useMemo(() => {
    const history = dData ? dData.flatMap(page => page.items) : []
    const active = activePageData?.items || []
    const map = new Map<string, ActivityTask>()
    for (const t of history) map.set(t.task_id, t)
    // The active overlay wins: it carries the freshest state for its ids.
    for (const t of active) map.set(t.task_id, t)
    return Array.from(map.values()).sort((a, b) => b.started_at - a.started_at)
  }, [dData, activePageData])

  const hasMoreDl = dData && dData[dData.length - 1]?.items.length === PAGE_SIZE

  const adultCount = useMemo(() => allTasks.filter(isAdultTask).length, [allTasks])

  const visibleTasks = useMemo(
    () => (showAdult ? allTasks : allTasks.filter((t) => !isAdultTask(t))),
    [allTasks, showAdult]
  )

  const activeDl = visibleTasks.filter((t) => t.task_type === "download" && !isTaskFinished(t))
  const finishedDl = visibleTasks.filter((t) => t.task_type === "download" && isTaskFinished(t))

  const activeTc = visibleTasks.filter((t) => t.task_type === "transcode" && !isTaskFinished(t))
  const finishedTc = visibleTasks.filter((t) => t.task_type === "transcode" && isTaskFinished(t))

  const dismissTask = async (id: string) => {
    await api.dismissTask(id)
    dMutate()
    activeMutate()
  }

  const cancelTask = async (id: string) => {
    await api.cancelDownload(id).catch(() => {})
    dMutate()
    activeMutate()
  }

  const retryTask = async (task: ActivityTask) => {
    if (task.task_type === "download") {
      await api.download(task.workshop_id).catch(() => {})
    } else {
      await api.libraryTranscode(task.workshop_id).catch(() => {})
    }
    dMutate()
    activeMutate()
  }

  const dismissAll = async (stage: "complete" | "error") => {
    await api.dismissAllTasks(stage)
    dMutate()
    activeMutate()
  }

  const handleRetryAllTc = async () => {
    await api.libraryTranscodeRetryAll().catch(() => {})
    dMutate()
    activeMutate()
  }

  const combinedError = dError || activeError
  const hasAnyData = dData !== undefined || activePageData !== undefined

  // A transient fetch failure (Safari aborting requests on background, a
  // dropped poll) must not blow away an already-rendered list — keep showing
  // cached data and let the next successful revalidation catch us up.
  if (combinedError && !hasAnyData)
    return <div className="error">{(combinedError as Error).message}</div>

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1 className="page-title">Activity</h1>
        </div>
        <div className="page-actions">
          <div className="summary-stat compact">
            <span className="summary-stat-label mono">active</span>
            <strong>{activePageData?.total ?? activeDl.length + activeTc.length}</strong>
          </div>
          <div className="summary-stat compact">
            <span className="summary-stat-label mono">finished</span>
            <strong>{finishedDl.length + finishedTc.length}</strong>
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

      {visibleTasks.length === 0 && (
        <div className="empty-state">
          {allTasks.length > 0 && !showAdult && adultCount > 0
            ? "Tasks are hidden in safe mode. Open the secret filter to reveal them."
            : "No active tasks. Pick a wallpaper in Browse."}
        </div>
      )}

      {(activeDl.length > 0 || activeTc.length > 0) && (
        <section className="task-section">
          <h2 className="section-title mono">Active</h2>
          <ul className="task-list">
            {[...activeDl, ...activeTc].sort((a, b) => b.started_at - a.started_at).map((t) => (
              <TaskRow key={t.task_id} task={t} onDismiss={dismissTask} onCancel={cancelTask} onRetry={retryTask} />
            ))}
          </ul>
        </section>
      )}

      {(finishedDl.length > 0 || finishedTc.length > 0) && (
        <section className="task-section">
          <div className="task-section-header">
            <h2 className="section-title mono">Finished</h2>
            <div>
              {visibleTasks.some((t) => t.stage === "complete") && (
                <button type="button" className="btn btn-secondary" onClick={() => dismissAll("complete")} aria-label="Clear all completed" style={{ marginRight: 8 }}>
                  Clear Completed
                </button>
              )}
              {visibleTasks.some(isTaskFailed) && (
                <>
                  {finishedTc.some(isTaskFailed) && (
                    <button type="button" className="btn btn-secondary" onClick={handleRetryAllTc} aria-label="Retry all failed transcodes" style={{ marginRight: 8 }}>
                      Retry All Transcodes
                    </button>
                  )}
                  <button type="button" className="btn btn-secondary" onClick={() => dismissAll("error")} aria-label="Clear all failed">
                    Clear Failed
                  </button>
                </>
              )}
            </div>
          </div>
          <ul className="task-list">
            {[...finishedDl, ...finishedTc].sort((a, b) => b.started_at - a.started_at).map((t) => (
              <TaskRow key={t.task_id} task={t} onDismiss={dismissTask} onCancel={cancelTask} onRetry={retryTask} />
            ))}
          </ul>
          {hasMoreDl && (
            <div style={{ marginTop: 16, textAlign: "center" }}>
              <button className="btn btn-secondary" onClick={() => setDSize(dSize + 1)}>Load More</button>
            </div>
          )}
        </section>
      )}
    </div>
  )
}

interface TaskRowProps {
  task: ActivityTask
  onDismiss: (id: string) => void
  onCancel: (id: string) => void
  onRetry: (task: ActivityTask) => void
}

const TaskRow = ({ task, onDismiss, onCancel, onRetry }: TaskRowProps) => {
  const { mobile } = useLayout()
  const failed = isTaskFailed(task)
  const stageClass = failed ? "dl-stage-error" : task.stage === "complete" ? "dl-stage-ok" : ""

  const elapsedMs = (task.finished_at ?? Date.now()) - task.started_at
  const elapsed = formatElapsed(elapsedMs / 1000)

  const showBar = !isTaskFinished(task)
  const determinate = task.percent !== null && task.percent !== undefined
  const percentClamped =
    determinate && task.percent !== null ? Math.max(0, Math.min(100, task.percent)) : 0

  const stageLabel = taskStageLabel(task)

  if (mobile && isTaskFinished(task)) {
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
            <div className="task-row-mobile-id mono">
              {task.task_type === "transcode" ? "TRANSCODE" : "DOWNLOAD"} • {task.workshop_id}
            </div>
          </div>
        </div>
        {failed && task.message && (
          <div className="task-row-mobile-error mono">{task.message}</div>
        )}
        <div className="task-row-mobile-foot">
          <span className={`status-pill ${stageClass}`}>{stageLabel}</span>
          <span className="mono" style={{ fontSize: 11, color: "var(--paper-faint)" }}>
            {elapsed}
          </span>
          {failed && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => onRetry(task)}
            >
              Retry
            </button>
          )}
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => onDismiss(task.task_id)}
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
            {stageLabel}
          </span>
        </div>
        <div className="task-meta">
          <span className="mono task-info-pill">{task.task_type === "transcode" ? "TRANSCODE" : "DOWNLOAD"}</span>
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
        {failed && task.message && (
          <div className="task-message task-message-error">{task.message}</div>
        )}
      </div>
      <div className="task-actions">
        {isTaskFinished(task) ? (
          <>
            {failed && (
              <button type="button" className="btn btn-secondary" onClick={() => onRetry(task)} style={{ marginRight: 8 }}>
                Retry
              </button>
            )}
            <button type="button" className="btn btn-secondary" onClick={() => onDismiss(task.task_id)}>
              Dismiss
            </button>
          </>
        ) : task.task_type === "download" ? (
          <button type="button" className="btn btn-secondary" onClick={() => onCancel(task.workshop_id)}>
            Cancel
          </button>
        ) : null}
      </div>
    </li>
  )
}
