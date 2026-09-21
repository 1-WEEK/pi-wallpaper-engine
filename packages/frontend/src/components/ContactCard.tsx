// ContactCard — one cell of the Browse contact sheet (spec §4.1): N° index
// above, still image, title + mono metadata below, and an ADD affordance
// that triggers the existing download intent (same api.download flow as the
// legacy WallpaperCard). Hover reveals ADD; committed states (queued /
// working / in library / failed) stay visible.
import { useEffect, useState } from "react"
import type { CSSProperties } from "react"
import type { ActivityTask, WorkshopItem } from "@pwe/shared"
import { api } from "../api.js"
import { isTaskFinished, taskStageLabel } from "../taskDisplay.js"

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

export const ContactCard = ({
  item,
  index,
  isInLibrary = false,
  downloadTask,
  onDownloadQueued,
  cursor = false,
  onSelect,
  onOpen,
}: {
  item: WorkshopItem
  index: number
  isInLibrary?: boolean
  downloadTask?: ActivityTask
  onDownloadQueued?: () => void
  /** True while the keyboard cursor sits on this card (ticket 05 basic
   *  roaming; the full 1-bit focus band lands with ticket 06). */
  cursor?: boolean
  onSelect?: () => void
  /** Opens the immersive focus view (double-click on the media). */
  onOpen?: () => void
}) => {
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

  const activeTask = downloadTask && !isTaskFinished(downloadTask) ? downloadTask : null
  const taskError = downloadTask?.stage === "error" ? downloadTask.message : null
  const ready = isInLibrary || downloadTask?.stage === "complete"
  const size = formatFileSize(item.file_size)
  const tag = pickTag(item)

  return (
    <article
      className={`bws-card pt-enter${cursor ? " bws-cursor" : ""}`}
      style={{ "--pt-i": index } as CSSProperties}
      onClick={onSelect}
    >
      <div className="bws-card-index mono">N°{String(index + 1).padStart(3, "0")}</div>
      <div className="bws-media" onDoubleClick={onOpen}>
        {item.preview_url ? (
          <img className="bws-media-img" src={item.preview_url} alt={item.title} loading="lazy" />
        ) : (
          <div className="bws-media-img bws-media-empty" />
        )}
      </div>
      <div className="bws-caption">
        <span className="bws-caption-title" title={item.title}>
          {item.title}
        </span>
        <span className="bws-caption-meta mono">
          {size ?? "—"}
          {tag ? ` / ${tag.toUpperCase()}` : ""}
        </span>
        {ready ? (
          <span className="bws-add is-static mono">IN LIBRARY</span>
        ) : taskError ? (
          <button type="button" className="bws-add is-static mono" onClick={handleDownload}>
            RETRY
          </button>
        ) : activeTask ? (
          <span className="bws-add is-static mono">{taskStageLabel(activeTask).toUpperCase()}</span>
        ) : queued || starting ? (
          <span className="bws-add is-static mono">QUEUED</span>
        ) : (
          <button
            type="button"
            className="bws-add mono"
            disabled={starting}
            onClick={handleDownload}
          >
            ADD
          </button>
        )}
      </div>
      {(error || taskError) && <div className="bws-card-err mono">{error ?? taskError}</div>}
    </article>
  )
}
