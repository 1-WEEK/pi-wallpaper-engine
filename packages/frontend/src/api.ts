import type { DisplayMode, LibraryItem, PlayMode, WorkshopItem } from "@pwe/shared"
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
  content_rating: string | null
  rating_sex: string | null
  adult_hint: number
  stage: DownloadStage
  message: string
  started_at: number
  finished_at: number | null
  percent: number | null
  bytes_done: number | null
  bytes_total: number | null
}

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

export interface SystemSummary {
  config: {
    steam: {
      username: string
      web_api_key_masked: string
      steamcmd_path: string
    }
    paths: {
      data_root: string
      source_dir: string
      optimized_dir: string
    }
    screen: {
      width: number
      height: number
      default_display_mode: DisplayMode
    }
    mpv: {
      binary_path: string
      ipc_socket: string
      hwdec: string
      gpu_api: string
    }
    server: {
      host: string
      port: number
    }
  }
  status: {
    player: {
      playing: boolean
      current_workshop_id: string | null
      path: string | null
      display_mode: DisplayMode
      play_mode: PlayMode
      current_title: string | null
      current_preview_url: string | null
      current_resolution: string | null
      current_codec: string | null
    }
    display: {
      configured: boolean
      state: "on" | "off" | "unknown"
      source: "probed" | "cached" | "default"
      error_kind: string | null
    }
    storage: {
      available: boolean
      path: string
      data_root: string
      default_root: string
      using_default: boolean
      last_error: string | null
      used_bytes: number | null
      free_bytes: number | null
      total_bytes: number | null
      used_percent: number | null
      error: string | null
    }
    library: {
      total: number
    }
    downloads: {
      active: number
      finished: number
    }
    sleep: {
      active: boolean
      deadline: number | null
    }
  }
}

const AUTH_EVENT = "pwe-auth-changed"

export const dispatchAuthChange = () => {
  window.dispatchEvent(new Event(AUTH_EVENT))
}

export const onAuthChange = (handler: () => void): (() => void) => {
  window.addEventListener(AUTH_EVENT, handler)
  return () => window.removeEventListener(AUTH_EVENT, handler)
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
  cancelDownload: (id: string) =>
    fetch(`/api/download/${id}/cancel`, { method: "POST" }).then(
      json<{ ok: boolean; workshopId?: string; status?: string; error?: string }>
    ),

  systemSummary: () => fetch(`/api/system/summary`).then(json<SystemSummary>),
  getStorage: () => fetch(`/api/storage`).then(json<StorageStatus>),
  storageLocations: () => fetch(`/api/storage/locations`).then(json<StorageLocation[]>),
  storageDirectories: (path: string) =>
    fetch(`/api/storage/directories?${new URLSearchParams({ path }).toString()}`).then(
      json<StorageDirectoryListing>
    ),
  createStorageDirectory: (body: { parent: string; name: string }) =>
    fetch(`/api/storage/directories`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(json<{ path: string; display_path: string }>),
  validateStorageTarget: (targetRoot: string) =>
    fetch(`/api/storage/validate-target`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_root: targetRoot }),
    }).then(json<StorageTargetValidation>),
  switchStorageRoot: (targetRoot: string) =>
    fetch(`/api/storage/root`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_root: targetRoot }),
    }).then(json<StorageStatus>),
  cancelMigration: () =>
    fetch(`/api/storage/cancel`, { method: "POST" }).then(json<StorageStatus>),

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
  playerMode: (mode: PlayMode) =>
    fetch(`/api/player/mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    }).then(json<unknown>),
  playerNext: () => fetch(`/api/player/next`, { method: "POST" }).then(json<unknown>),
  playerPrev: () => fetch(`/api/player/prev`, { method: "POST" }).then(json<unknown>),
  setSleep: (minutes: number) =>
    fetch(`/api/player/sleep`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ minutes }),
    }).then(json<{ active: boolean; deadline: number | null }>),
  playerStatus: () =>
    fetch(`/api/player/status`).then(
      json<{
        playing: boolean
        current_workshop_id: string | null
        path: string | null
        display_mode: DisplayMode
      }>
    ),

  displayOn: () =>
    fetch(`/api/display/on`, { method: "POST" }).then(
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
    fetch(`/api/display/off`, { method: "POST" }).then(
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

export interface PlayerWatchSnapshot {
  playing: boolean
  current_workshop_id: string | null
  path: string | null
  display_mode: DisplayMode
  play_mode: PlayMode
  current_title: string | null
  current_preview_url: string | null
  current_resolution: string | null
  current_codec: string | null
}
