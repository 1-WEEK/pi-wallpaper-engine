import { Context, Effect, Layer, Ref } from "effect"
import {
  DbError,
  DisplayError,
  LibraryNotFoundError,
  MpvIpcError,
  StorageError,
} from "@pwe/shared"
import type { DisplayStatus } from "./Display.js"
import { Display } from "./Display.js"
import { Library } from "./Library.js"
import { Logger } from "./Logger.js"
import { Mpv } from "./Mpv.js"
import { PlayerState, type RestoreReason } from "./PlayerState.js"

const AUTO_OFF_DELAY_MS = 30_000

export interface PowerOnResult {
  readonly ok: true
  readonly state: "on"
  readonly restored: boolean
  readonly restore_error?: string
}

export interface PlayerPowerImpl {
  readonly play: (
    workshopId: string
  ) => Effect.Effect<
    { readonly ok: true; readonly path: string },
    DbError | LibraryNotFoundError | MpvIpcError | StorageError
  >
  readonly stopForIdle: () => Effect.Effect<{ readonly ok: true }, MpvIpcError>
  readonly displayOff: () => Effect.Effect<{ readonly ok: true; readonly state: "off" }, DisplayError | MpvIpcError>
  readonly displayOn: () => Effect.Effect<PowerOnResult, DisplayError>
}

export class PlayerPower extends Context.Tag("PlayerPower")<
  PlayerPower,
  PlayerPowerImpl
>() {}

export const shouldAutoRestoreOnStartup = (status: DisplayStatus): boolean =>
  status.state === "on" && status.source === "probed"

export const PlayerPowerLive = Layer.scoped(
  PlayerPower,
  Effect.gen(function* () {
    const display = yield* Display
    const library = yield* Library
    const logger = yield* Logger
    const mpv = yield* Mpv
    const playerState = yield* PlayerState
    const timerRef = yield* Ref.make<ReturnType<typeof setTimeout> | null>(null)

    const logWarn = (message: string) => logger.warn(message).pipe(Effect.ignore)

    const cancelAutoOff = Effect.gen(function* () {
      const timer = yield* Ref.get(timerRef)
      if (timer) clearTimeout(timer)
      yield* Ref.set(timerRef, null)
    })

    const rememberCurrentOrKeep = (reason: RestoreReason) =>
      Effect.gen(function* () {
        const status = yield* mpv.status()
        if (status.current_workshop_id) {
          yield* playerState.setRestore(status.current_workshop_id, reason).pipe(
            Effect.catchTag("DbError", (e) =>
              logWarn(`Failed to persist player restore state: ${String(e.cause)}`)
            )
          )
          return
        }

        // A previous /player/stop may already have stored the wallpaper before
        // mpv entered idle. Preserve it when Display Off happens during that
        // countdown.
        yield* playerState.getRestore().pipe(
          Effect.catchTag("DbError", (e) =>
            logWarn(`Failed to read player restore state: ${String(e.cause)}`)
          ),
          Effect.asVoid
        )
      })

    const clearRestoreBestEffort = (context: string) =>
      playerState.clearRestore().pipe(
        Effect.catchTag("DbError", (e) =>
          logWarn(`Failed to clear player restore state after ${context}: ${String(e.cause)}`)
        )
      )

    const restoreSaved = (source: "display_on" | "startup") =>
      Effect.gen(function* () {
        const saved = yield* playerState.getRestore().pipe(
          Effect.catchTag("DbError", (e) =>
            Effect.gen(function* () {
              yield* logWarn(`Failed to read player restore state on ${source}: ${String(e.cause)}`)
              return null
            })
          )
        )
        if (!saved) return { restored: false } as const

        const item = yield* library.get(saved.workshop_id).pipe(
          Effect.catchTag("LibraryNotFoundError", () =>
            Effect.gen(function* () {
              yield* clearRestoreBestEffort("missing library item")
              return null
            })
          ),
          Effect.catchAll((e) =>
            Effect.gen(function* () {
              yield* logWarn(`Could not restore ${saved.workshop_id} on ${source}: ${String(e)}`)
              return null
            })
          )
        )
        if (!item) return { restored: false } as const

        const restored = yield* Effect.gen(function* () {
          const path = yield* library.playablePath(item)
          yield* mpv.play(item.workshop_id, path)
          yield* library.update(item.workshop_id, { last_played_at: Date.now() })
          yield* mpv.setDisplayMode(item.display_mode)
          yield* clearRestoreBestEffort("successful restore")
          return true
        }).pipe(
          Effect.catchAll((e) =>
            Effect.gen(function* () {
              const message = e instanceof Error ? e.message : String(e)
              yield* logWarn(`Could not restore ${saved.workshop_id} on ${source}: ${message}`)
              return false
            })
          )
        )

        return restored
          ? ({ restored: true } as const)
          : ({ restored: false, restore_error: "Restore failed; saved state kept." } as const)
      })

    const stopAndPowerOff = (reason: RestoreReason) =>
      Effect.gen(function* () {
        yield* rememberCurrentOrKeep(reason)
        yield* mpv.stop()
        yield* display.off()
        yield* Ref.set(timerRef, null)
        return { ok: true as const, state: "off" as const }
      })

    const scheduleAutoOff = Effect.gen(function* () {
      yield* cancelAutoOff
      const timer = setTimeout(() => {
        Effect.runFork(
          stopAndPowerOff("auto_off").pipe(
            Effect.catchAll((e) =>
              logWarn(`Auto display off failed: ${e instanceof Error ? e.message : String(e)}`)
            )
          )
        )
      }, AUTO_OFF_DELAY_MS)
      ;(timer as { unref?: () => void }).unref?.()
      yield* Ref.set(timerRef, timer)
    })

    yield* Effect.addFinalizer(() => cancelAutoOff)

    const startupRestore = Effect.gen(function* () {
      const status = yield* display.status()
      if (!shouldAutoRestoreOnStartup(status)) return
      const restored = yield* restoreSaved("startup")
      if (restored.restored) {
        yield* logger.info("Restored wallpaper after backend startup with display on")
      }
    }).pipe(
      Effect.catchAll((e) =>
        logWarn(`Startup display restore skipped: ${e instanceof Error ? e.message : String(e)}`)
      )
    )

    yield* Effect.forkScoped(startupRestore)

    return {
      play: (workshopId) =>
        Effect.gen(function* () {
          yield* cancelAutoOff
          yield* clearRestoreBestEffort("explicit play")
          const item = yield* library.get(workshopId)
          const path = yield* library.playablePath(item)
          yield* mpv.play(item.workshop_id, path)
          yield* library.update(item.workshop_id, { last_played_at: Date.now() })
          yield* mpv.setDisplayMode(item.display_mode)
          return { ok: true, path }
        }),

      stopForIdle: () =>
        Effect.gen(function* () {
          const status = yield* mpv.status()
          if (status.current_workshop_id) {
            yield* playerState.setRestore(status.current_workshop_id, "manual_stop").pipe(
              Effect.catchTag("DbError", (e) =>
                logWarn(`Failed to persist player restore state on stop: ${String(e.cause)}`)
              )
            )
            yield* mpv.stop()
            yield* scheduleAutoOff
          } else {
            yield* mpv.stop()
            yield* cancelAutoOff
            yield* clearRestoreBestEffort("idle stop")
          }
          return { ok: true }
        }),

      displayOff: () =>
        Effect.gen(function* () {
          yield* cancelAutoOff
          return yield* stopAndPowerOff("display_off")
        }),

      displayOn: () =>
        Effect.gen(function* () {
          yield* cancelAutoOff
          yield* display.on()
          const restored = yield* restoreSaved("display_on")
          return { ok: true, state: "on", ...restored }
        }),
    }
  })
)
