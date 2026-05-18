import { useEffect, useMemo, useState } from "react"
import { isAdultContent, type DisplayMode, type LibraryItem } from "@pwe/shared"
import useSWR from "swr"
import { api } from "../api.js"
import { useLayout } from "../components/mobile/index.js"

interface Props {
  nowPlayingId: string | null
  onSystemRefresh: () => void
}

const DISPLAY_MODES: DisplayMode[] = ["fill", "fit", "stretch"]

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

export const Library = ({ nowPlayingId, onSystemRefresh }: Props) => {
  const { mobile } = useLayout()
  const [view, setView] = useState<"grid" | "list">("grid")
  const [privacyOpen, setPrivacyOpen] = useState(false)
  const [showAdult, setShowAdult] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Force grid view on mobile; list view's 5-column row would overflow at 390px.
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
  const handleDisplayMode = (id: string, mode: DisplayMode) => {
    api
      .libraryUpdate(id, { display_mode: mode })
      .then(async () => {
        setError(null)
        await mutate()
        onSystemRefresh()
      })
      .catch((e: Error) => setError(e.message))
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <div className="page-kicker mono library-kicker-row">
            <span>Downloaded wallpapers</span>
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
          <h1 className="page-title">Library</h1>
        </div>
        <div className="page-actions">
          <div className="summary-stat compact">
            <span className="summary-stat-label mono">items</span>
            <strong>{visibleRows.length}</strong>
          </div>
          <div className="summary-stat compact">
            <span className="summary-stat-label mono">size</span>
            <strong>{formatBytes(totalSize)}</strong>
          </div>
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
      {visibleRows.length === 0 && (
        <div className="empty-state">Library is empty. Download some wallpapers in Browse.</div>
      )}

      {visibleRows.length > 0 && view === "grid" && (
        <div className="library-grid">
          {visibleRows.map((row) => {
            const active = row.workshop_id === nowPlayingId
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
                  {active && <span className="library-playing-pill">Now playing</span>}
                </div>
                <div className="library-card-body">
                  <div className="library-card-title-row">
                    <h2 className="library-card-title" title={row.title}>
                      {row.title}
                    </h2>
                    <span className={`status-pill status-pill-${row.transcode_status}`}>
                      {row.transcode_status}
                    </span>
                  </div>
                  <div className="library-card-meta mono">
                    {playableResolution(row)} · {playableCodec(row)} ·{" "}
                    {formatBytes(row.transcoded_size ?? row.source_size)}
                  </div>
                  <div className="library-card-footer">
                    <div className="library-card-actions">
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => handlePlay(row.workshop_id)}
                      >
                        Play
                      </button>
                      <button
                        type="button"
                        className="btn btn-danger"
                        onClick={() => handleDelete(row.workshop_id)}
                      >
                        Delete
                      </button>
                    </div>
                    <div className="segmented segmented-compact library-card-modes">
                      {DISPLAY_MODES.map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          className={`segmented-button ${
                            row.display_mode === mode ? "active" : ""
                          }`}
                          onClick={() => handleDisplayMode(row.workshop_id, mode)}
                        >
                          {mode}
                        </button>
                      ))}
                    </div>
                  </div>
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
                    {active && <span className="library-row-playing mono">now playing</span>}
                  </div>
                  <div className="library-row-meta mono">
                    {playableResolution(row)} · {playableCodec(row)} ·{" "}
                    {formatBytes(row.transcoded_size ?? row.source_size)}
                  </div>
                </div>
                <div className="segmented segmented-compact">
                  {DISPLAY_MODES.map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      className={`segmented-button ${row.display_mode === mode ? "active" : ""}`}
                      onClick={() => handleDisplayMode(row.workshop_id, mode)}
                    >
                      {mode}
                    </button>
                  ))}
                </div>
                <button type="button" className="btn btn-primary" onClick={() => handlePlay(row.workshop_id)}>
                  Play
                </button>
                <button type="button" className="btn btn-danger" onClick={() => handleDelete(row.workshop_id)}>
                  Delete
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
