// FocusView — the immersive focus view (implementation ticket 05, spec §4.1,
// 14 票定稿): full-screen scrim + 16:9 media + Clash title + mono metadata +
// DOWNLOAD/STEAM actions (pure download semantics — no PLAY). It replaces and
// absorbs the old card-detail overlay; ←/→ steps through the result list,
// Esc / scrim click closes. The open/close motion (VT morph out, FLIP ghost
// back) is orchestrated by the parent — this component only renders the
// surface. The `.pfocus-media` element carries `view-transition-name:
// card-media` (browse.css); scrim and stage stay unnamed (spec §5 F3: nested
// named snapshots are the mid-morph white-block artifact source).
import { useState } from "react"
import type { ActivityTask, WorkshopItem } from "@pwe/shared"
import { api } from "../api.js"
import { isTaskFinished, taskStageLabel } from "../taskDisplay.js"
import { RESOLUTION_TAGS } from "../workshopTags.js"

const RES_SET: ReadonlySet<string> = new Set(RESOLUTION_TAGS)

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
  const preferred = tags.find((tag) => tag !== "Video" && !RES_SET.has(tag))
  return preferred ?? tags.find((tag) => tag !== "Video") ?? tags[0] ?? null
}

export const resolutionTag = (item: WorkshopItem): string | null => {
  const res = item.tags?.find((t) => RES_SET.has(t.tag))?.tag
  return res ? res.replace(/\s/g, "") : null
}

export const FocusView = ({
  item,
  index,
  vt = false,
  closing = false,
  isInLibrary = false,
  downloadTask,
  onStep,
  onRequestClose,
  onDownloadQueued,
}: {
  item: WorkshopItem
  index: number
  /** True while the open ran as a View Transition — the stage's entrance is
   *  delayed so the media morph leads and the chrome settles after (F3). */
  vt?: boolean
  /** True during the 150ms exit beat (spec §5 F1), before unmount. */
  closing?: boolean
  isInLibrary?: boolean
  downloadTask?: ActivityTask
  onStep: (dir: 1 | -1) => void
  onRequestClose: () => void
  onDownloadQueued?: () => void
}) => {
  const [starting, setStarting] = useState(false)
  const [queued, setQueued] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const activeTask = downloadTask && !isTaskFinished(downloadTask) ? downloadTask : null
  const taskError = downloadTask?.stage === "error" ? downloadTask.message : null
  const ready = isInLibrary || downloadTask?.stage === "complete"

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

  const size = formatFileSize(item.file_size)
  const res = resolutionTag(item)
  const tag = pickTag(item)
  // QueryItems' creator is a Steam account id — a raw number is noise, hide it.
  const creator = item.creator && !/^\d+$/.test(item.creator) ? `BY ${item.creator}` : null
  const steamUrl = `https://steamcommunity.com/sharedfiles/filedetails/?id=${item.publishedfileid}`

  const stageClass = closing
    ? "pfocus-stage pfocus-closing"
    : vt
      ? "pfocus-stage pfocus-vt"
      : "pfocus-stage"

  return (
    <div className="pfocus" role="dialog" aria-modal="true" aria-label={item.title}>
      <div
        className={`pfocus-scrim${closing ? " pfocus-scrim-out" : ""}`}
        onClick={onRequestClose}
      />
      <button
        type="button"
        className="pfocus-step"
        aria-label="Previous wallpaper"
        onClick={() => onStep(-1)}
      >
        ←
      </button>
      <figure className={stageClass}>
        <div className="pfocus-media">
          {item.preview_url ? (
            <img src={item.preview_url} alt={item.title} />
          ) : (
            <div className="pfocus-media-empty" />
          )}
          <span className="pfocus-no mono">N°{String(index + 1).padStart(3, "0")}</span>
        </div>
        <figcaption className="pfocus-cap">
          <h2 className="pfocus-title">{item.title}</h2>
          <div className="pfocus-meta mono">
            <span>ID {item.publishedfileid}</span>
            <span>{size ?? "—"}</span>
            <span>{res ?? "—"}</span>
            <span>{tag?.toUpperCase() ?? "—"}</span>
          </div>
          {creator && <div className="pfocus-creator mono">{creator}</div>}
          <div className="pfocus-actions">
            {ready ? (
              <span className="pfocus-static mono">IN LIBRARY</span>
            ) : activeTask ? (
              <span className="pfocus-static mono">
                {taskStageLabel(activeTask).toUpperCase()}
              </span>
            ) : (
              <button
                type="button"
                className="pfocus-primary mono"
                disabled={starting || queued}
                onClick={handleDownload}
              >
                {starting || queued ? "QUEUED" : taskError ? "RETRY DOWNLOAD ↓" : "DOWNLOAD ↓"}
              </button>
            )}
            <a className="pfocus-cmd mono" href={steamUrl} target="_blank" rel="noreferrer">
              STEAM ↗
            </a>
          </div>
          {(error || taskError) && (
            <div className="pfocus-err mono">{error ?? taskError}</div>
          )}
        </figcaption>
      </figure>
      <button
        type="button"
        className="pfocus-step"
        aria-label="Next wallpaper"
        onClick={() => onStep(1)}
      >
        →
      </button>
      <div className="pfocus-hint mono">←/→ STEP · ESC CLOSE</div>
    </div>
  )
}
