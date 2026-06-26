import type { DisplayMode, DownloadStage, DownloadTask, LibraryItem, PlayMode, PlayerStatus, SystemSummary, WorkshopItem } from "@pwe/shared"
export type { DownloadStage, DownloadTask, PlayerStatus, SystemSummary }
import type { WorkshopSort } from "./workshopTags.js"


export interface MigrationProgress {
  state: "running" | "done" | "failed"
  moved_bytes: number
  total_bytes: number
  error: string | null
}

export interface StorageStatus {
  available: boolean
  data_root: string
  default_root: string
  using_default: boolean
  last_error: string | null
  migration: MigrationProgress | null
}

export interface StorageLocation {
  id: string
  label: string
  path: string
  display_path: string
}

export interface StorageDirectoryEntry {
  name: string
  path: string
}

export interface StorageDirectoryListing {
  path: string
  display_path: string
  entries: StorageDirectoryEntry[]
}

export type StorageTargetValidation =
  | {
      ok: true
      path: string
      display_path: string
      free_bytes: number
      total_bytes: number
      used_bytes: number
      is_empty: boolean
      has_source: boolean
      has_optimized: boolean
      message: string
    }
  | {
      ok: false
      error: string
    }


const AUTH_EVENT = "pwe-auth-changed"

export const dispatchAuthChange = () => {
  window.dispatchEvent(new Event(AUTH_EVENT))
}

export const onAuthChange = (handler: () => void): (() => void) => {
  window.addEventListener(AUTH_EVENT, handler)
  return () => window.removeEventListener(AUTH_EVENT, handler)
}
const FETCH_TIMEOUT_MS = 30_000

const fetchWithTimeout = (
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs: number = FETCH_TIMEOUT_MS
): Promise<Response> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer))
}

const json = async <T>(res: Response): Promise<T> => {
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    if (res.status === 401) {
      dispatchAuthChange()
    }
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
    return fetchWithTimeout(`/api/workshop/search?${params.toString()}`).then(
      json<WorkshopSearchResult>
    )
  },

  workshopItem: (id: string) =>
    fetchWithTimeout(`/api/workshop/item/${id}`).then(json<WorkshopItem>),

  download: (workshopId: string) =>
    fetchWithTimeout(`/api/download/${workshopId}`, { method: "POST" }).then(
      json<{ ok: boolean; workshopId: string }>
    ),

  downloadTasks: () => fetchWithTimeout(`/api/download/tasks`).then(json<DownloadTask[]>),
  dismissDownloadTask: (id: string) =>
    fetchWithTimeout(`/api/download/tasks/${id}`, { method: "DELETE" }).then(json<{ ok: true }>),
  cancelDownload: (id: string) =>
    fetchWithTimeout(`/api/download/${id}/cancel`, { method: "POST" }).then(
      json<{ ok: boolean; workshopId?: string; status?: string; error?: string }>
    ),

  systemSummary: () => fetchWithTimeout(`/api/system/summary`).then(json<SystemSummary>),
  getStorage: () => fetchWithTimeout(`/api/storage`).then(json<StorageStatus>),
  storageLocations: () => fetchWithTimeout(`/api/storage/locations`).then(json<StorageLocation[]>),
  storageDirectories: (path: string) =>
    fetchWithTimeout(`/api/storage/directories?${new URLSearchParams({ path }).toString()}`).then(
      json<StorageDirectoryListing>
    ),
  createStorageDirectory: (body: { parent: string; name: string }) =>
    fetchWithTimeout(`/api/storage/directories`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(json<{ path: string; display_path: string }>),
  validateStorageTarget: (targetRoot: string) =>
    fetchWithTimeout(`/api/storage/validate-target`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_root: targetRoot }),
    }).then(json<StorageTargetValidation>),
  switchStorageRoot: (targetRoot: string) =>
    fetchWithTimeout(`/api/storage/root`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_root: targetRoot }),
    }).then(json<StorageStatus>),
  cancelMigration: () => fetchWithTimeout(`/api/storage/cancel`, { method: "POST" }).then(json<StorageStatus>),

  libraryList: () => fetchWithTimeout(`/api/library`).then(json<LibraryItem[]>),
  libraryDelete: (id: string) =>
    fetchWithTimeout(`/api/library/${id}`, { method: "DELETE" }).then(json<{ ok: true }>),
  libraryUpdate: (id: string, patch: { display_mode?: DisplayMode }) =>
    fetchWithTimeout(`/api/library/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).then(json<{ ok: true }>),

  play: (id: string) => fetchWithTimeout(`/api/player/play/${id}`, { method: "POST" }).then(json<unknown>),
  pause: () => fetchWithTimeout(`/api/player/pause`, { method: "POST" }).then(json<unknown>),
  resume: () => fetchWithTimeout(`/api/player/resume`, { method: "POST" }).then(json<unknown>),
  stop: () => fetchWithTimeout(`/api/player/stop`, { method: "POST" }).then(json<unknown>),
  setDisplayMode: (mode: DisplayMode) =>
    fetchWithTimeout(`/api/player/display-mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    }).then(json<unknown>),
  playerMode: (mode: PlayMode) =>
    fetchWithTimeout(`/api/player/mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    }).then(json<unknown>),
  playerNext: () => fetchWithTimeout(`/api/player/next`, { method: "POST" }).then(json<unknown>),
  playerPrev: () => fetchWithTimeout(`/api/player/prev`, { method: "POST" }).then(json<unknown>),
  setRotationInterval: (seconds: number) =>
    fetchWithTimeout(`/api/player/interval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seconds }),
    }).then(json<unknown>),
  setSleep: (minutes: number) =>
    fetchWithTimeout(`/api/player/sleep`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ minutes }),
    }).then(json<{ active: boolean; deadline: number | null }>),
  playerStatus: () =>
    fetchWithTimeout(`/api/player/status`).then(
      json<{
        playing: boolean
        current_workshop_id: string | null
        path: string | null
        display_mode: DisplayMode
      }>
    ),

  displayOn: () =>
    fetchWithTimeout(`/api/display/on`, { method: "POST" }).then(
      json<{
        ok: boolean
        state?: "on" | "off"
        restored?: boolean
        restore_error?: string
        error?: string
        kind?: string
      }>
    ),
  displayOff: () =>
    fetchWithTimeout(`/api/display/off`, { method: "POST" }).then(
      json<{ ok: boolean; state?: "on" | "off"; error?: string; kind?: string }>
    ),

  downloadProgressWS: (workshopId: string): WebSocket => {
    const proto = window.location.protocol === "https:" ? "wss" : "ws"
    return new WebSocket(`${proto}://${window.location.host}/api/download/progress/${workshopId}`)
  },

  playerWatchWS: (): WebSocket => {
    const proto = window.location.protocol === "https:" ? "wss" : "ws"
    return new WebSocket(`${proto}://${window.location.host}/api/player/watch`)
  },
}

