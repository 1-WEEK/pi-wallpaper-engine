import { Schema } from "effect"

// Playback rotation mode. `single` keeps the legacy behavior (one wallpaper on
// loop). `sequential` and `shuffle` rotate the whole library on an interval.
export const PlayMode = Schema.Literal("single", "sequential", "shuffle")
export type PlayMode = typeof PlayMode.Type
