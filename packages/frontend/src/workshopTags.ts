// Wallpaper Engine tag taxonomy on Steam Workshop. Steam has no endpoint to
// enumerate available tags; this list mirrors the WE upload form. Tags are
// case-sensitive and AND'd together via match_all_tags on the backend.

export const GENRE_TAGS = [
  "Abstract",
  "Animal",
  "Anime",
  "Cartoon",
  "CGI",
  "Cyberpunk",
  "Fantasy",
  "Game",
  "Girls",
  "Guys",
  "Landscape",
  "Medieval",
  "Memes",
  "MMD",
  "Music",
  "Nature",
  "Pixel art",
  "Realistic",
  "Relaxing",
  "Retro",
  "Sci-Fi",
  "Technology",
  "Television",
  "Vehicle",
  "Unspecified",
] as const

// WE tags resolution by exact pixel string, not aspect ratio. Verified against
// real workshop item tag arrays (`return_tags=true` response).
export const RESOLUTION_TAGS = [
  "1280 x 720",
  "1920 x 1080",
  "2560 x 1440",
  "3840 x 2160",
  "Portrait",
] as const

export const AGE_TAGS = ["Everyone", "Questionable", "Mature"] as const

export const SORT_OPTIONS = [
  { value: "trend", label: "Trending" },
  { value: "recent", label: "Recent" },
] as const

export type WorkshopSort = (typeof SORT_OPTIONS)[number]["value"]
