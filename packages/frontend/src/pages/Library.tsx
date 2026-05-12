import { useEffect, useState } from "react"
import type { DisplayMode, LibraryItem } from "@pwe/shared"
import { api } from "../api.js"

export const Library = () => {
  const [rows, setRows] = useState<LibraryItem[]>([])
  const [error, setError] = useState<string | null>(null)

  const refresh = () => {
    api
      .libraryList()
      .then(setRows)
      .catch((e: Error) => setError(e.message))
  }

  useEffect(() => {
    refresh()
    // Light polling so completed downloads appear without a manual refresh.
    // Cheap query — sqlite read.
    const handle = setInterval(refresh, 5000)
    return () => clearInterval(handle)
  }, [])

  const handlePlay = (id: string) => api.play(id).catch((e: Error) => setError(e.message))
  const handleDelete = (id: string) => {
    if (!confirm("Delete this wallpaper from library? Source file will be removed.")) return
    api
      .libraryDelete(id)
      .then(refresh)
      .catch((e: Error) => setError(e.message))
  }
  const handleDisplayMode = (id: string, mode: DisplayMode) => {
    api
      .libraryUpdate(id, { display_mode: mode })
      .then(refresh)
      .catch((e: Error) => setError(e.message))
  }

  if (error) return <div className="error">{error}</div>

  return (
    <div className="page">
      <h2>Library ({rows.length})</h2>
      {rows.length === 0 && <div className="empty">Empty. Download some wallpapers in Browse.</div>}
      <ul className="lib-list">
        {rows.map((r) => (
          <li key={r.workshop_id} className="lib-row">
            {r.preview_url && (
              <img className="lib-thumb" src={r.preview_url} alt={r.title} loading="lazy" />
            )}
            <div className="lib-info">
              <div className="lib-title">{r.title}</div>
              <div className="lib-meta">
                {r.source_resolution} {r.source_codec} ·{" "}
                {(r.source_size / 1024 / 1024).toFixed(1)} MB ·{" "}
                <span className="tag">{r.transcode_status}</span>
              </div>
            </div>
            <div className="lib-actions">
              <button onClick={() => handlePlay(r.workshop_id)}>Play</button>
              <select
                value={r.display_mode}
                onChange={(e) =>
                  handleDisplayMode(r.workshop_id, e.target.value as DisplayMode)
                }
              >
                <option value="fill">Fill</option>
                <option value="fit">Fit</option>
                <option value="stretch">Stretch</option>
              </select>
              <button className="danger" onClick={() => handleDelete(r.workshop_id)}>
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
