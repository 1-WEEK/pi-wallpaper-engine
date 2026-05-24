import { Context, Effect, Layer } from "effect"
import { DbError } from "@pwe/shared"
import { Db } from "./Db.js"

export type RestoreReason = "manual_stop" | "display_off" | "auto_off"

export interface RestoreState {
  readonly workshop_id: string
  readonly reason: RestoreReason
  readonly updated_at: number
}

export interface PlayerStateImpl {
  readonly getRestore: () => Effect.Effect<RestoreState | null, DbError>
  readonly setRestore: (
    workshopId: string,
    reason: RestoreReason
  ) => Effect.Effect<void, DbError>
  readonly clearRestore: () => Effect.Effect<void, DbError>
}

export class PlayerState extends Context.Tag("PlayerState")<
  PlayerState,
  PlayerStateImpl
>() {}

interface RestoreRow {
  readonly restore_workshop_id: string
  readonly restore_reason: RestoreReason
  readonly updated_at: number
}

export const PlayerStateLive = Layer.effect(
  PlayerState,
  Effect.gen(function* () {
    const db = yield* Db

    return {
      getRestore: () =>
        Effect.gen(function* () {
          const row = yield* db.queryOne<RestoreRow>(
            `SELECT restore_workshop_id, restore_reason, updated_at
             FROM player_state
             WHERE id = 'singleton'`
          )
          if (!row) return null
          return {
            workshop_id: row.restore_workshop_id,
            reason: row.restore_reason,
            updated_at: row.updated_at,
          }
        }),

      setRestore: (workshopId, reason) =>
        db.exec(
          `INSERT INTO player_state (id, restore_workshop_id, restore_reason, updated_at)
           VALUES ('singleton', ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             restore_workshop_id = excluded.restore_workshop_id,
             restore_reason = excluded.restore_reason,
             updated_at = excluded.updated_at`,
          [workshopId, reason, Date.now()]
        ),

      clearRestore: () => db.exec(`DELETE FROM player_state WHERE id = 'singleton'`),
    }
  })
)
