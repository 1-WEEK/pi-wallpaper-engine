import type { LibraryItem, SystemSummary, WorkshopSearchResult } from "@pwe/shared"
import type { WorkshopItem } from "@pwe/shared"

export const mockLibraryItem = (overrides: Partial<LibraryItem> = {}): LibraryItem => ({
  workshop_id: "1693728660",
  title: "Neon City",
  author: "TestAuthor",
  preview_url: "",
  content_rating: "Everyone",
  rating_sex: null,
  source_path: "source/1693728660/wallpaper.mp4",
  source_resolution: "3840x2160",
  source_codec: "h264",
  source_size: 500_000_000,
  downloaded_at: 1_700_000_000_000,
  transcode_status: "completed",
  transcode_progress: 100,
  transcode_error: null,
  transcoded_path: "optimized/1693728660.mp4",
  transcoded_resolution: "1920x1080",
  transcoded_codec: "hevc",
  transcoded_size: 100_000_000,
  display_mode: "fill",
  last_played_at: null,
  ...overrides,
})

export const mockWorkshopItems = (n: number): WorkshopItem[] =>
  Array.from({ length: n }, (_, i) => ({
    publishedfileid: String(3000000000 + i),
    title: `Wallpaper ${i + 1}`,
    description: `A test wallpaper item number ${i + 1}.`,
    preview_url: `https://example.com/preview/${i}.jpg`,
    file_url: `https://example.com/file/${i}.mp4`,
    file_size: 1024 * 1024 * 5,
    creator: "TestAuthor",
    tags: [{ tag: "Video" }],
  }))

export const mockSearchResult = (
  items: WorkshopItem[],
  total: number,
  nextCursor?: string
): WorkshopSearchResult => ({
  total,
  items,
  nextCursor,
})

/** Minimal valid SystemSummary matching the full schema shape. */
export const mockSystemSummary = (): SystemSummary => ({
  config: {
    steam: {
      username: "test",
      web_api_key_masked: "abc***",
      steamcmd_path: "/usr/local/bin/steamcmd",
    },
    paths: {
      data_root: "/mock/data",
      source_dir: "/mock/data/source",
      optimized_dir: "/mock/data/optimized",
    },
    screen: {
      width: 1920,
      height: 1080,
      default_display_mode: "fill",
    },
    mpv: {
      binary_path: "/usr/bin/mpv",
      ipc_socket: "/tmp/mpv.sock",
      hwdec: "auto",
      gpu_api: "opengl",
    },
    server: {
      host: "0.0.0.0",
      port: 8080,
    },
  },
  status: {
    player: {
      playing: false,
      current_workshop_id: null,
      path: null,
      display_mode: "fill",
      play_mode: "single",
      rotation_interval_sec: 30,
      current_title: null,
      current_preview_url: null,
      current_resolution: null,
      current_codec: null,
    },
    display: {
      configured: false,
      state: "unknown",
      source: "default",
      error_kind: null,
    },
    storage: {
      available: true,
      path: "/mock/data",
      data_root: "/mock/data",
      default_root: "/mock/data",
      using_default: true,
      last_error: null,
      used_bytes: 0,
      free_bytes: 1000000000,
      total_bytes: 1000000000,
      used_percent: 0,
      error: null,
    },
    library: { total: 0 },
    downloads: { active: 0, finished: 0 },
    sleep: { active: false, deadline: null },
    transcode: {
      pending: 0,
      claimed: 0,
      running: 0,
      uploading: 0,
      completed: 0,
      failed: 0,
    },
  },
})
