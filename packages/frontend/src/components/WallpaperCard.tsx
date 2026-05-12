import { useState } from "react"
import type { WorkshopItem } from "@pwe/shared"
import { api } from "../api.js"

interface Props {
  item: WorkshopItem
  isInLibrary?: boolean
}

export const WallpaperCard = ({ item, isInLibrary }: Props) => {
  const [downloading, setDownloading] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const handleDownload = () => {
    setDownloading(true)
    setError(null)
    setDone(false)

    const ws = api.downloadProgressWS(item.publishedfileid)
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as { stage: string; message: string }
        if (msg.stage === "error") {
          setError(msg.message)
          setDownloading(false)
        } else if (msg.stage === "complete") {
          setDone(true)
          setDownloading(false)
        } else {
          setProgress(msg.message)
        }
      } catch {
        // ignore
      }
    }
    ws.onerror = () => setError("WebSocket connection error")

    api.download(item.publishedfileid).catch((e: Error) => {
      setError(e.message)
      setDownloading(false)
      ws.close()
    })
  }

  const steamUrl = `https://steamcommunity.com/sharedfiles/filedetails/?id=${item.publishedfileid}`

  return (
    <div className="card">
      {item.preview_url && (
        <img className="card-preview" src={item.preview_url} alt={item.title} loading="lazy" />
      )}
      <div className="card-body">
        <h3 className="card-title">{item.title}</h3>
        {item.description && (
          <p className="card-desc">{item.description.slice(0, 120)}</p>
        )}
        <div className="card-actions">
          {isInLibrary || done ? (
            <span className="tag">✓ Downloaded</span>
          ) : downloading ? (
            <span className="tag">{progress ?? "Downloading..."}</span>
          ) : (
            <button onClick={handleDownload}>Download</button>
          )}
          <a href={steamUrl} target="_blank" rel="noreferrer" className="btn-link">
            Steam
          </a>
        </div>
        {error && <div className="card-error">{error}</div>}
      </div>
    </div>
  )
}
