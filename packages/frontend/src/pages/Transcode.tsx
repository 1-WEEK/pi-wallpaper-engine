import { useMemo, useEffect, useState } from "react"
import useSWR, { useSWRConfig } from "swr"
import { api } from "../api.js"
import { formatBytes } from "../format.js"
import type { LibraryItem, TranscodeStatus, TranscodeProgressEvent } from "@pwe/shared"

const STATUS_LABEL: Record<TranscodeStatus, string> = {
  skipped: "Skipped",
  pending: "Queued",
  claimed: "Queued",
  running: "Running",
  uploading: "Uploading",
  completed: "Completed",
  failed: "Failed",
}

export const Transcode = () => {
  const { data, error } = useSWR("library-transcode", api.libraryList)
  const { mutate } = useSWRConfig()

  useEffect(() => {
    let ws = api.libraryTranscodeWatchWS()
    
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as TranscodeProgressEvent
        mutate(
          "library-transcode",
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
          mutate("library-transcode") // fully fetch to get output size etc
        }
      } catch (err) {
        console.error("Transcode WS parse error", err)
      }
    }
    
    return () => ws.close()
  }, [mutate])

  const [isRetryingAll, setIsRetryingAll] = useState(false)

  const handleRetryAll = async () => {
    setIsRetryingAll(true)
    try {
      await api.libraryTranscodeRetryAll()
      await mutate("library-transcode")
    } catch (err) {
      console.error(err)
    } finally {
      setIsRetryingAll(false)
    }
  }

  const tasks = useMemo(() => {
    if (!data) return []
    return data.filter((item) => item.transcode_status)
  }, [data])

  const hasFailed = tasks.some(t => t.transcode_status === "failed")

  if (error) return <div className="error">{(error as Error).message}</div>

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <div className="page-kicker mono library-kicker-row">
            <span>NAS Transcode Worker</span>
          </div>
          <h1 className="page-title">Transcode</h1>
        </div>
        <div className="page-actions">
          {hasFailed && (
            <button
              className="btn btn-secondary"
              onClick={handleRetryAll}
              disabled={isRetryingAll}
            >
              {isRetryingAll ? "Retrying..." : "Retry All Failed"}
            </button>
          )}
          <div className="summary-stat compact">
            <span className="summary-stat-label mono">Total</span>
            <strong>{tasks.length}</strong>
          </div>
        </div>
      </header>

      {tasks.length === 0 && data && (
        <div className="empty-state">No transcode tasks found.</div>
      )}

      {tasks.length > 0 && (
        <ul className="transcode-list">
          {tasks.map((task) => (
            <TranscodeRow key={task.workshop_id} task={task} />
          ))}
        </ul>
      )}
    </div>
  )
}

const TranscodeRow = ({ task }: { task: LibraryItem }) => {
  const { mutate } = useSWRConfig()
  const [isRetrying, setIsRetrying] = useState(false)

  const status = task.transcode_status
  const isRunning = status === "running" || status === "uploading"
  const isCompleted = status === "completed" || status === "skipped"
  const isFailed = status === "failed"

  let statusClass = "status-pill-pending"
  if (isRunning) statusClass = "status-pill-running"
  if (isCompleted) statusClass = "status-pill-completed"
  if (isFailed) statusClass = "status-pill-failed"
  if (status === "skipped") statusClass = "status-pill-skipped"

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
    <li className={`transcode-row ${isCompleted ? "finished" : "active"}`}>
      <div className="transcode-thumb-wrap">
        {task.preview_url ? (
          <img className="transcode-thumb" src={task.preview_url} alt={task.title} loading="lazy" />
        ) : (
          <div className="transcode-thumb transcode-thumb-empty" />
        )}
      </div>
      <div className="transcode-copy">
        <div className="transcode-title-row">
          <div className="transcode-title">{task.title}</div>
          <span className={`status-pill ${statusClass}`}>
            {STATUS_LABEL[status]}
          </span>
        </div>
        <div className="transcode-meta">
          <span className="mono">{task.workshop_id}</span>
          <span className="mono transcode-codec-info">
            {task.source_resolution} • {task.source_codec}
            {isCompleted && task.transcoded_codec && (
              <> → {task.transcoded_resolution} • {task.transcoded_codec}</>
            )}
          </span>
          <span className="mono transcode-size-info">
            {task.source_size ? formatBytes(task.source_size) : "Unknown size"}
            {isCompleted && task.transcoded_size && (
              <> → {formatBytes(task.transcoded_size)}</>
            )}
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
          <div className="transcode-message transcode-message-error">{task.transcode_error}</div>
        )}
      </div>
      <div className="transcode-actions">
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
