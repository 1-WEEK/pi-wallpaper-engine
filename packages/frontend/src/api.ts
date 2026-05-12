import type { DisplayMode, LibraryItem, WorkshopItem } from "@pwe/shared"
import type { WorkshopSort } from "./workshopTags.js"

export type DownloadStage =
  | "starting"
  | "downloading"
  | "finalizing"
  | "done"
  | "complete"
  | "error"

export interface DownloadTask {
  workshop_id: string
  title: string
  preview_url: string
  stage: DownloadStage
  message: string
  started_at: number
  finished_at: number | null
  percent: number | null
  bytes_done: number | null
  bytes_total: number | null
}

const json = async <T>(res: Response): Promise<T> => {
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(body.error ?? `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

export interface WorkshopSearchOptions {
  cursor?: string
  pageSize?: number
  tags?: ReadonlyArray<string>
  sort?: WorkshopSort
}

export interface WorkshopSearchResult {
  total: number
  items: WorkshopItem[]
  nextCursor?: string
}

export const api = {
  workshopSearch: (q: string, opts: WorkshopSearchOptions = {}) => {
    const params = new URLSearchParams({ q, cursor: opts.cursor ?? "*" })
    if (opts.pageSize) params.set("pageSize", String(opts.pageSize))
    if (opts.tags && opts.tags.length > 0) params.set("tags", opts.tags.join(","))
    if (opts.sort) params.set("sort", opts.sort)
    return fetch(`/api/workshop/search?${params.toString()}`).then(
      json<WorkshopSearchResult>
    )
  },

  workshopItem: (id: string) =>
    fetch(`/api/workshop/item/${id}`).then(json<WorkshopItem>),

  download: (workshopId: string) =>
    fetch(`/api/download/${workshopId}`, { method: "POST" }).then(
      json<{ ok: boolean; workshopId: string }>
    ),

  downloadTasks: () => fetch(`/api/download/tasks`).then(json<DownloadTask[]>),
  dismissDownloadTask: (id: string) =>
    fetch(`/api/download/tasks/${id}`, { method: "DELETE" }).then(json<{ ok: true }>),

  libraryList: () => fetch(`/api/library`).then(json<LibraryItem[]>),
  libraryDelete: (id: string) =>
    fetch(`/api/library/${id}`, { method: "DELETE" }).then(json<{ ok: true }>),
  libraryUpdate: (id: string, patch: { display_mode?: DisplayMode }) =>
    fetch(`/api/library/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).then(json<{ ok: true }>),

  play: (id: string) => fetch(`/api/player/play/${id}`, { method: "POST" }).then(json<unknown>),
  pause: () => fetch(`/api/player/pause`, { method: "POST" }).then(json<unknown>),
  resume: () => fetch(`/api/player/resume`, { method: "POST" }).then(json<unknown>),
  stop: () => fetch(`/api/player/stop`, { method: "POST" }).then(json<unknown>),
  setDisplayMode: (mode: DisplayMode) =>
    fetch(`/api/player/display-mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    }).then(json<unknown>),
  playerStatus: () =>
    fetch(`/api/player/status`).then(
      json<{
        playing: boolean
        current_workshop_id: string | null
        path: string | null
        display_mode: DisplayMode
      }>
    ),

  downloadProgressWS: (workshopId: string): WebSocket => {
    const proto = window.location.protocol === "https:" ? "wss" : "ws"
    return new WebSocket(`${proto}://${window.location.host}/api/download/progress/${workshopId}`)
  },
}
