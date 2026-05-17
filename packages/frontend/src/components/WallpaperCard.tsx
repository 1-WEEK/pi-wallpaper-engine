import { useEffect, useState } from "react"
import type { WorkshopItem } from "@pwe/shared"
import { api, type DownloadTask } from "../api.js"

interface Props {
  item: WorkshopItem
  isInLibrary?: boolean
  downloadTask?: DownloadTask
  onDownloadQueued?: () => void
}

const isFinishedTask = (task: DownloadTask): boolean =>
  task.stage === "complete" || task.stage === "error" || task.finished_at !== null

const formatFileSize = (raw: WorkshopItem["file_size"]): string | null => {
  if (raw === undefined) return null
  const bytes = typeof raw === "string" ? parseInt(raw, 10) : raw
  if (!Number.isFinite(bytes)) return null
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

const pickTag = (item: WorkshopItem): string | null => {
  const tags = item.tags?.map((tag) => tag.tag).filter(Boolean) ?? []
  if (tags.length === 0) return null
  const preferred = tags.find((tag) => tag !== "Video")
  return preferred ?? tags[0] ?? null
}

const stageLabel = (task: DownloadTask): string => {
  switch (task.stage) {
    case "starting":
      return "Queued"
    case "downloading":
      return "Downloading"
    case "finalizing":
      return "Finalizing"
    case "done":
      return "SteamCMD done"
    case "complete":
      return "Complete"
    case "error":
      return "Failed"
  }
}

export const WallpaperCard = ({
  item,
  isInLibrary,
  downloadTask,
  onDownloadQueued,
}: Props) => {
  const [starting, setStarting] = useState(false)
  const [queued, setQueued] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (downloadTask || isInLibrary) setQueued(false)
  }, [downloadTask, isInLibrary])

  const handleDownload = () => {
    setStarting(true)
    setError(null)
    api
      .download(item.publishedfileid)
      .then(() => {
        setQueued(true)
        onDownloadQueued?.()
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setStarting(false))
  }

  const steamUrl = `https://steamcommunity.com/sharedfiles/filedetails/?id=${item.publishedfileid}`
  const activeTask = downloadTask && !isFinishedTask(downloadTask) ? downloadTask : null
  const taskPercent =
    activeTask?.percent !== null && activeTask?.percent !== undefined
      ? Math.max(0, Math.min(100, activeTask.percent))
      : null
  const taskError = downloadTask?.stage === "error" ? downloadTask.message : null
  const overlayTag = pickTag(item)
  const overlaySize = formatFileSize(item.file_size)
  const readyState = isInLibrary || downloadTask?.stage === "complete"
  const queuedState = queued || starting

  return (
    <article className="wallpaper-card">
      <div className="wallpaper-media">
        {item.preview_url ? (
          <img
            className="wallpaper-preview"
            src={item.preview_url}
            alt={item.title}
            loading="lazy"
          />
        ) : (
          <div className="wallpaper-preview wallpaper-preview-empty" />
        )}
        <div className="wallpaper-media-overlay" />
        {overlaySize && <div className="wallpaper-pill wallpaper-pill-top mono">{overlaySize}</div>}
        {overlayTag && <div className="wallpaper-pill wallpaper-pill-bottom mono">{overlayTag}</div>}
      </div>

      <div className="wallpaper-body">
        <div className="wallpaper-title-row">
          <h3 className="wallpaper-title">{item.title}</h3>
          {readyState ? (
            <span className="status-pill status-pill-ok">In library</span>
          ) : activeTask ? (
            <span className="status-pill status-pill-working">{stageLabel(activeTask)}</span>
          ) : queuedState ? (
            <span className="status-pill status-pill-working">Queued</span>
          ) : taskError ? (
            <span className="status-pill status-pill-error">Failed</span>
          ) : (
            <span className="status-pill">Workshop</span>
          )}
        </div>
        <div className="wallpaper-id mono">{item.publishedfileid}</div>
        {item.description && <p className="wallpaper-description">{item.description.slice(0, 140)}</p>}

        {activeTask && (
          <div className="wallpaper-progress-block">
            <div className="wallpaper-progress-meta">
              <span>{stageLabel(activeTask)}</span>
              <span className="mono">
                {taskPercent !== null ? `${taskPercent.toFixed(1)}%` : activeTask.message}
              </span>
            </div>
            <div
              className={`card-progress ${taskPercent === null ? "indeterminate" : ""}`}
              role="progressbar"
              aria-valuenow={taskPercent ?? undefined}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className="card-progress-fill"
                style={taskPercent !== null ? { width: `${taskPercent}%` } : undefined}
              />
            </div>
          </div>
        )}

        <div className="wallpaper-actions">
          {readyState ? (
            <a href={steamUrl} target="_blank" rel="noreferrer" className="btn btn-secondary">
              Steam
            </a>
          ) : taskError ? (
            <>
              <button type="button" className="btn btn-primary" onClick={handleDownload}>
                Retry
              </button>
              <a href={steamUrl} target="_blank" rel="noreferrer" className="btn btn-secondary">
                Steam
              </a>
            </>
          ) : activeTask || queuedState ? (
            <>
              <button type="button" className="btn btn-secondary" disabled>
                Working…
              </button>
              <a href={steamUrl} target="_blank" rel="noreferrer" className="btn btn-secondary">
                Steam
              </a>
            </>
          ) : (
            <>
              <button
                type="button"
                className="btn btn-primary"
                disabled={starting}
                onClick={handleDownload}
              >
                {starting ? "Queueing…" : "Download"}
              </button>
              <a href={steamUrl} target="_blank" rel="noreferrer" className="btn btn-secondary">
                Steam
              </a>
            </>
          )}
        </div>
        {(error || taskError) && <div className="card-error">{error ?? taskError}</div>}
      </div>
    </article>
  )
}
