import { useEffect, useMemo, useState } from "react"
import { isAdultContent, type LibraryItem } from "@pwe/shared"
import useSWR from "swr"
import { api } from "../api.js"
import { spaceSavedPercent } from "../format.js"
import { appIcons } from "../icons.js"
import { useLayout } from "../components/mobile/index.js"
import { VideoPreview } from "../components/VideoPreview.js"

interface Props {
  nowPlayingId: string | null
  onSystemRefresh: () => void
}



const formatBytes = (bytes: number): string => {
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

const playableResolution = (row: LibraryItem): string =>
  row.transcoded_resolution ?? row.source_resolution

const playableCodec = (row: LibraryItem): string => row.transcoded_codec ?? row.source_codec

const isAdultRow = (row: LibraryItem): boolean =>
  isAdultContent({
    title: row.title,
    contentRating: row.content_rating,
    ratingSex: row.rating_sex,
  })

const showsTranscodeBadge = (status: LibraryItem["transcode_status"]): boolean =>
  status === "failed" ||
  status === "running" ||
  status === "uploading" ||
  status === "claimed" ||
  status === "pending"

const canRetranscode = (status: LibraryItem["transcode_status"]): boolean =>
  status === "failed" || status === "skipped"

const canPreview = (row: LibraryItem): boolean => row.transcode_status === "completed"

export const Library = ({ nowPlayingId, onSystemRefresh }: Props) => {
  const { mobile } = useLayout()
  const [view, setView] = useState<"grid" | "list">("grid")
  const [privacyOpen, setPrivacyOpen] = useState(false)
  const [showAdult, setShowAdult] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [previewItem, setPreviewItem] = useState<LibraryItem | null>(null)

  useEffect(() => {
    if (mobile && view !== "grid") setView("grid")
  }, [mobile, view])
  const { data: rows = [], mutate } = useSWR("library-list", api.libraryList, {
    refreshInterval: 5000,
    revalidateIfStale: true,
  })

  const adultCount = useMemo(() => rows.filter(isAdultRow).length, [rows])
  const visibleRows = useMemo(
    () => (showAdult ? rows : rows.filter((row) => !isAdultRow(row))),
    [rows, showAdult]
  )
  const totalSize = useMemo(
    () => visibleRows.reduce((sum, row) => sum + (row.transcoded_size ?? row.source_size), 0),
    [visibleRows]
  )

  const handlePlay = (id: string) =>
    api
      .play(id)
      .then(() => {
        setError(null)
        onSystemRefresh()
      })
      .catch((e: Error) => setError(e.message))

  // Start a rotation over the currently visible (privacy-filtered) library:
  // set the mode, then play the anchor so the backend arms the timer from it.
  const handlePlayRotation = (mode: "sequential" | "shuffle") => {
    // Rotation excludes adult wallpapers on the backend; pick a safe anchor too.
    const safeRows = rows.filter((r) => !isAdultRow(r))
    const start =
      mode === "shuffle"
        ? safeRows[Math.floor(Math.random() * safeRows.length)]
        : safeRows[0]
    if (!start) return
    api
      .playerMode(mode)
      .then(() => api.play(start.workshop_id))
      .then(() => {
        setError(null)
        onSystemRefresh()
      })
      .catch((e: Error) => setError(e.message))
  }

  const handleDelete = (id: string) => {
    if (!confirm("Delete this wallpaper from library? Source file will be removed.")) return
    api
      .libraryDelete(id)
      .then(async () => {
        setError(null)
        await mutate()
        onSystemRefresh()
      })
      .catch((e: Error) => setError(e.message))
  }
  const handleTranscode = (id: string) =>
    api
      .libraryTranscode(id)
      .then(async (res) => {
        setError(null)
        setNotice(res.transcode_status === "skipped" ? `Not queued — ${res.reason}` : null)
        await mutate()
      })
      .catch((e: Error) => setError(e.message))

  const handleTranscodeAll = () =>
    api
      .libraryTranscodeRetryAll()
      .then(async (res) => {
        setError(null)
        setNotice(`Transcode sweep: ${res.queued} queued, ${res.skipped} skipped`)
        await mutate()
      })
      .catch((e: Error) => setError(e.message))



  const countLabel = `${visibleRows.length} wallpaper${visibleRows.length === 1 ? "" : "s"} · ${formatBytes(totalSize)}`

  return (
    <div className="page library-page">
      <header className="page-header library-page-header">
        <div className="library-page-title-block">
          <h1 className="page-title">Library</h1>
          <span className="page-count mono">{countLabel}</span>
        </div>
        <div className="page-actions">
          {visibleRows.length > 0 && (
            <div className="library-rotation-actions">
              <button
                type="button"
                className="btn library-rotation-btn"
                onClick={() => handlePlayRotation("sequential")}
              >
                <span className="btn-icon">{appIcons.modeSequential}</span>
                Play all
              </button>
              <button
                type="button"
                className="btn library-rotation-btn"
                onClick={() => handlePlayRotation("shuffle")}
              >
                <span className="btn-icon">{appIcons.modeShuffle}</span>
                Shuffle
              </button>
              {rows.some((row) => canRetranscode(row.transcode_status)) && (
                <button
                  type="button"
                  className="btn library-rotation-btn"
                  onClick={handleTranscodeAll}
                >
                  Transcode all
                </button>
              )}
            </div>
          )}
          {!mobile && (
            <div className="segmented">
              <button
                type="button"
                className={`segmented-button ${view === "grid" ? "active" : ""}`}
                onClick={() => setView("grid")}
              >
                Grid
              </button>
              <button
                type="button"
                className={`segmented-button ${view === "list" ? "active" : ""}`}
                onClick={() => setView("list")}
              >
                List
              </button>
            </div>
          )}
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
            <div className="library-privacy-title mono">safe shelf</div>
            <div className="library-privacy-note">
              {adultCount > 0
                ? showAdult
                  ? "All saved wallpapers are visible in this session."
                  : `${adultCount} mature item${adultCount === 1 ? "" : "s"} hidden in this session.`
                : "No mature-marked wallpapers found."}
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

      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="info-banner">{notice}</div>}
      {visibleRows.length === 0 && (
        <div className="empty-state">Library is empty. Download some wallpapers in Browse.</div>
      )}

      {visibleRows.length > 0 && view === "grid" && (
        <div className="library-grid">
          {visibleRows.map((row) => {
            const active = row.workshop_id === nowPlayingId
            const showBadge = showsTranscodeBadge(row.transcode_status)
            const savedPct = spaceSavedPercent(row)
            return (
              <article
                key={row.workshop_id}
                className={`library-card ${active ? "library-card-active" : ""}`}
              >
                <div className="library-card-media">
                  {row.preview_url ? (
                    <img
                      className="library-card-thumb"
                      src={row.preview_url}
                      alt={row.title}
                      loading="lazy"
                    />
                  ) : (
                    <div className="library-card-thumb library-card-thumb-empty" />
                  )}
                  {active && <span className="library-playing-pill">● Now playing</span>}
                  {showBadge && (
                    <span className={`library-card-badge status-pill-${row.transcode_status} mono`}>
                      {row.transcode_status}
                    </span>
                  )}
                  {!showBadge && savedPct !== null && (
                    <span className="library-card-badge status-pill-completed mono">
                      ↓ saved {savedPct}%
                    </span>
                  )}
                  <div className="library-card-overlay">
                    <div className="library-card-title" title={row.title}>
                      {row.title}
                    </div>
                    <div className="library-card-meta mono">
                      {playableResolution(row)} · {playableCodec(row)} ·{" "}
                      {formatBytes(row.transcoded_size ?? row.source_size)}
                    </div>
                  </div>
                </div>
                <div className="library-card-body">
                  <button
                    type="button"
                    className="btn btn-primary library-card-play"
                    onClick={() => handlePlay(row.workshop_id)}
                  >
                    <span className="library-card-play-icon">{appIcons.play}</span>
                    Play
                  </button>
                  {canPreview(row) && (
                    <button
                      type="button"
                      className="btn library-card-preview"
                      onClick={() => setPreviewItem(row)}
                      aria-label="Preview this wallpaper in the browser"
                    >
                      {mobile ? "▶" : "Preview"}
                    </button>
                  )}
                  {canRetranscode(row.transcode_status) && (
                    <button
                      type="button"
                      className="btn library-card-transcode"
                      onClick={() => handleTranscode(row.workshop_id)}
                      aria-label="Transcode this wallpaper"
                    >
                      {mobile ? "⟳" : "Transcode"}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-ghost-danger library-card-delete"
                    onClick={() => handleDelete(row.workshop_id)}
                    aria-label="Delete from library"
                  >
                    {mobile ? "✕" : "Delete"}
                  </button>
                </div>

              </article>
            )
          })}
        </div>
      )}

      {visibleRows.length > 0 && view === "list" && (
        <ul className="library-list">
          {visibleRows.map((row) => {
            const active = row.workshop_id === nowPlayingId
            const showBadge = showsTranscodeBadge(row.transcode_status)
            const savedPct = spaceSavedPercent(row)
            return (
              <li key={row.workshop_id} className={`library-row ${active ? "active" : ""}`}>
                {row.preview_url ? (
                  <img className="library-row-thumb" src={row.preview_url} alt={row.title} loading="lazy" />
                ) : (
                  <div className="library-row-thumb library-card-thumb-empty" />
                )}
                <div className="library-row-copy">
                  <div className="library-row-title">
                    <span className="library-row-title-text" title={row.title}>
                      {row.title}
                    </span>
                    {active && <span className="library-row-playing mono">● now playing</span>}
                    {showBadge && (
                      <span className={`status-pill status-pill-${row.transcode_status} mono`}>
                        {row.transcode_status}
                      </span>
                    )}
                    {!showBadge && savedPct !== null && (
                      <span className="status-pill status-pill-completed mono">
                        ↓ saved {savedPct}%
                      </span>
                    )}
                  </div>
                  <div className="library-row-meta mono">
                    {playableResolution(row)} · {playableCodec(row)} ·{" "}
                    {formatBytes(row.transcoded_size ?? row.source_size)}
                  </div>
                </div>

                {canPreview(row) && (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setPreviewItem(row)}
                    aria-label="Preview this wallpaper in the browser"
                  >
                    Preview
                  </button>
                )}
                {canRetranscode(row.transcode_status) && (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => handleTranscode(row.workshop_id)}
                  >
                    Transcode
                  </button>
                )}
                <button type="button" className="btn btn-primary" onClick={() => handlePlay(row.workshop_id)}>
                  Play
                </button>
                <button
                  type="button"
                  className="btn btn-ghost-danger"
                  onClick={() => handleDelete(row.workshop_id)}
                >
                  Delete
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {previewItem && <VideoPreview item={previewItem} onClose={() => setPreviewItem(null)} />}
    </div>
  )
}
