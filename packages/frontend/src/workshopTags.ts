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

// WE tags resolution by exact pixel string, not aspect ratio. Expanded from
// the original 5 to the 13-item census of real workshop tag arrays
// (QueryFiles, trending, Everyone): ultrawide/dual families, portrait
// variants, 1366x768 laptops, and the heavily-used "Other resolution".
export const RESOLUTION_TAGS = [
  "1280 x 720",
  "1366 x 768",
  "1920 x 1080",
  "2560 x 1440",
  "3840 x 2160",
  "Other resolution",
  "Ultrawide Standard Definition",
  "Ultrawide 2560 x 1080",
  "Ultrawide 3440 x 1440",
  "Dual 3840 x 1080",
  "Portrait Standard Definition",
  "Portrait 720 x 1280",
  "Portrait 1080 x 1920",
] as const

export const AGE_TAGS = ["Everyone", "Questionable", "Mature"] as const

export const SORT_OPTIONS = [
  { value: "trend", label: "Trending" },
  { value: "rating", label: "Rating" },
  { value: "recent", label: "Recent" },
] as const

export type WorkshopSort = (typeof SORT_OPTIONS)[number]["value"]

// Display abbreviation for the rail's narrow ledger rows. Filtering always
// uses the real Steam tag; this is presentation only.
export const displayTag = (tag: string): string =>
  tag.replace("Ultrawide ", "UW ").replace("Standard Definition", "SD").replace(/ x /g, "x")
