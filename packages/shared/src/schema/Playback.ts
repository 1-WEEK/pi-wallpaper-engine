import { Schema } from "effect"

// `single` loops one wallpaper; `sequential` and `shuffle` rotate the whole
// library on an interval.
export const PlayMode = Schema.Literals(["single", "sequential", "shuffle"])
export type PlayMode = typeof PlayMode.Type
