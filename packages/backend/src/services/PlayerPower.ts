import { Context, Effect, Fiber, Layer, PubSub, Semaphore, Stream } from "effect"
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
import { MediaRootWatch } from "./MediaRootWatch.js"
import { Mpv } from "./Mpv.js"
import { PlayerState, type RestoreReason } from "./PlayerState.js"
import { Storage } from "./Storage.js"

const AUTO_OFF_DELAY_MS = 30_000

export interface PowerOnResult {
  readonly ok: true
  readonly state: "on"
  readonly restored: boolean
  readonly restore_error?: string
  // Internal fact for the Playback orchestrator (which wallpaper was restored);
  // stripped before the result reaches HTTP.
  readonly restored_workshop_id?: string
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
  /**
   * One emission per wallpaper this service restored *by itself* once the media
   * root answered again, carrying the workshop id that started playing.
   *
   * Only for a wallpaper that was already playing when the share went away
   * (`media_lost`) — never for a startup restore, which takes the boot path and
   * deliberately does not arm rotation (ADR 0009).
   *
   * Ticket 01: playback is restarted from here because this is where both the
   * player and the display are owned, but rotation linkage belongs to
   * `Playback` (ADR 0009), so `Playback` subscribes and arms the sequence.
   */
  readonly recovered: () => Stream.Stream<string>
}

export class PlayerPower extends Context.Service<
  PlayerPower,
  PlayerPowerImpl
>()("PlayerPower") {}

export const shouldAutoRestoreOnStartup = (status: DisplayStatus): boolean =>
  status.state === "on" && status.source === "probed"

export const shouldPowerOnBeforePlay = (status: DisplayStatus): boolean =>
  status.state === "off"

export const PlayerPowerLive = Layer.effect(
  PlayerPower,
  Effect.gen(function* () {
    const display = yield* Display
    const library = yield* Library
    const logger = yield* Logger
    const mpv = yield* Mpv
    const playerState = yield* PlayerState
    const storage = yield* Storage
    const watch = yield* MediaRootWatch
    const recoveredPubSub = yield* PubSub.unbounded<string>()
    const scope = yield* Effect.scope
    let autoOffFiber: Fiber.Fiber<void> | undefined
    const lock = yield* Semaphore.make(1)
    const serialize = lock.withPermit
    let intentGeneration = 0

    const logWarn = (message: string) => logger.warn(message).pipe(Effect.ignore)

    const cancelAutoOff = Effect.gen(function* () {
      const timer = autoOffFiber
      autoOffFiber = undefined
      if (timer) yield* Fiber.interrupt(timer)
    })

    // Cancel before waiting for an intent already in progress, then again after
    // entering: that intent may have armed its timer while this caller waited.
    const control = <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.sync(() => { intentGeneration++ }).pipe(
        Effect.andThen(cancelAutoOff),
        Effect.andThen(serialize(cancelAutoOff.pipe(Effect.andThen(effect)))),
      )

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

        // A deliberate stop already owns its saved item during the grace
        // period. An automatic recovery hold must become deliberate when the
        // user powers off while the share is still absent.
        const saved = yield* playerState.getRestore().pipe(
          Effect.catchTag("DbError", e => logWarn(`Failed to read player restore state: ${String(e.cause)}`).pipe(Effect.as(null))),
        )
        if (saved && (saved.reason === "media_lost" || saved.reason === "startup")) {
          yield* playerState.setRestore(saved.workshop_id, reason).pipe(
            Effect.catchTag("DbError", e => logWarn(`Failed to persist player restore state: ${String(e.cause)}`)),
          )
        }
      })

    const clearRestoreBestEffort = (context: string) =>
      playerState.clearRestore().pipe(
        Effect.catchTag("DbError", (e) =>
          logWarn(`Failed to clear player restore state after ${context}: ${String(e.cause)}`)
        )
      )

    const formatDisplayError = (error: DisplayError): string =>
      `${error.kind}: ${error.message}${error.stderr ? `; stderr=${error.stderr}` : ""}`

    const powerOnDisplayIfKnownOff = Effect.gen(function* () {
      const status = yield* display.status().pipe(
        Effect.uninterruptible,
        Effect.catchTag("DisplayError", (e) =>
          Effect.gen(function* () {
            yield* logWarn(`Could not read display status before play: ${formatDisplayError(e)}`)
            return null
          })
        )
      )

      if (!status || !shouldPowerOnBeforePlay(status)) return

      yield* display.on().pipe(
        Effect.uninterruptible,
        Effect.catchTag("DisplayError", (e) =>
          logWarn(`Could not power on display before play: ${formatDisplayError(e)}`)
        )
      )
    })

    const restoreSaved = (source: "display_on" | "startup" | "media_recovery") =>
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
          Effect.catch((e) =>
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
          Effect.catch((e) =>
            Effect.gen(function* () {
              const message = e instanceof Error ? e.message : String(e)
              yield* logWarn(`Could not restore ${saved.workshop_id} on ${source}: ${message}`)
              return false
            })
          )
        )

        return restored
          ? ({ restored: true, restored_workshop_id: saved.workshop_id } as const)
          : ({ restored: false, restore_error: "Restore failed; saved state kept." } as const)
      })

    const stopAndPowerOff = (reason: RestoreReason) =>
      Effect.gen(function* () {
        yield* rememberCurrentOrKeep(reason)
        yield* mpv.release()
        // Hold the intent lock until the command and its owned cleanup settle
        // so an old off cannot finish after a newer play has powered back on.
        yield* display.off().pipe(Effect.uninterruptible)
        return { ok: true as const, state: "off" as const }
      })

    const scheduleAutoOff = Effect.gen(function* () {
      yield* cancelAutoOff
      autoOffFiber = yield* Effect.forkIn(
        Effect.sleep(AUTO_OFF_DELAY_MS).pipe(
          Effect.andThen(serialize(stopAndPowerOff("auto_off"))),
          Effect.catch(e => logWarn(`Auto display off failed: ${e instanceof Error ? e.message : String(e)}`)),
          Effect.asVoid,
        ),
        scope,
      )
    })

    yield* Effect.addFinalizer(() => cancelAutoOff)

    /**
     * Ticket 01: finish a restore that the media root interrupted, once the
     * root answers again.
     *
     * Two ways a wallpaper ends up held here: its file stopped mid-playback
     * when the share went away (`media_lost`), or a startup restore ran before
     * the mount existed. Unlike `display_off`/`auto_off`, nothing here waits for
     * the user — the point of the ticket is that a late mount ends with a
     * playing screen and no service restart.
     */
    const retryPendingRestore = Effect.gen(function* () {
      const generation = intentGeneration
      const saved = yield* playerState.getRestore().pipe(Effect.orElseSucceed(() => null))
      if (!saved) return
      // `display_off`/`manual_stop`/`auto_off` are *deliberate* holds: the user
      // turned the screen off or stopped playback, and the media root coming
      // back is not a reason to override that. Only a hold this ticket created
      // (`media_lost`) or one a startup restore already decided to honour
      // (`startup`) is retried.
      if (saved.reason !== "media_lost" && saved.reason !== "startup") return

      const restored = yield* restoreSaved("media_recovery")
      if (!restored.restored) return

      // ADR 0009 draws a line between the two: a wallpaper resumed because the
      // share came back was already playing, so its rotation sequence resumes
      // with it — but a wallpaper resumed *at boot* takes the startup path,
      // which deliberately loops the single wallpaper until an explicit play or
      // display-on. That distinction survives the outage, so only `media_lost`
      // is announced as a recovery.
      // A newer explicit intent owns rotation linkage even while it waits
      // for this restore to leave the power lock.
      if (saved.reason === "media_lost" && generation === intentGeneration) {
        yield* PubSub.publish(recoveredPubSub, saved.workshop_id)
      }
      yield* logger.info(`Restored ${saved.workshop_id} after the media root came back`)
    }).pipe(
      Effect.catchCause((cause) =>
        logWarn(`Media-root recovery restore failed: ${String(cause)}`)
      )
    )

    // The watch republishes every reachable probe, so a restore that fails
    // while the root is up is retried on the next probe rather than after the
    // next outage. The cadence belongs to the watch's existing loop, so this
    // adds no timer of its own.
    yield* Effect.forkScoped(
      watch
        .availableProbes()
        .pipe(
          Stream.mapEffect(() => serialize(retryPendingRestore)),
          Stream.runDrain
        )
        .pipe(
          Effect.catchCause((cause) =>
            logger.error(`Media-root recovery loop stopped: ${String(cause)}`)
          )
        )
    )

    // A file that stops on its own — the share holding it went away, the file
    // was deleted, a decode failed — leaves mpv idle with the wallpaper still
    // selected, which is indistinguishable from a paused player. mpv reports
    // the exact moment, so react to it rather than polling for it.
    //
    // The probe is what separates the two cases: a file that ended because the
    // share vanished is a wallpaper to hold and retry, while a file that ended
    // for any other reason (a codec quirk, a genuinely corrupt download) leaves
    // the root reachable and is left alone — holding it would silently delete a
    // wallpaper that is still on disk. Only when the root is down does this
    // persist the hold and put the watch back on alert instead of waiting out
    // its idle tick.
    yield* Effect.forkScoped(
      mpv
        .ended()
        .pipe(
          Stream.mapEffect(() =>
            serialize(Effect.gen(function* () {
              const status = yield* mpv.status()
              const workshopId = status.current_workshop_id
              if (!workshopId) return

              const probe = yield* storage.status()
              if (probe.available) return

              yield* playerState
                .setRestore(workshopId, "media_lost")
                .pipe(Effect.orElseSucceed(() => undefined))
              yield* logWarn(
                `Playback of ${workshopId} stopped because the media root is unavailable: ${probe.last_error ?? probe.data_root}`
              )
              yield* watch.probeNow()
            }))
          ),
          Stream.runDrain
        )
        .pipe(
          Effect.catchCause((cause) =>
            logger.error(`Playback interruption watch stopped: ${String(cause)}`)
          )
        )
    )

    const startupRestore = Effect.gen(function* () {
      const status = yield* display.status().pipe(Effect.uninterruptible)
      if (!shouldAutoRestoreOnStartup(status)) return

      // Record the intent *before* attempting it. The attempt itself fails
      // while the media root is not mounted yet (that is the nine-day outage in
      // the ticket), and a failed attempt must not discard the wallpaper the
      // user was watching: the persisted `startup` hold is what the recovery
      // loop retries once the share appears.
      const saved = yield* playerState.getRestore().pipe(Effect.orElseSucceed(() => null))
      if (saved && saved.reason !== "startup") {
        yield* playerState
          .setRestore(saved.workshop_id, "startup")
          .pipe(Effect.orElseSucceed(() => undefined))
      }

      const restored = yield* restoreSaved("startup")
      if (restored.restored) {
        yield* logger.info("Restored wallpaper after backend startup with display on")
      }
    }).pipe(
      Effect.catch((e) =>
        logWarn(`Startup display restore skipped: ${e instanceof Error ? e.message : String(e)}`)
      )
    )

    yield* Effect.forkScoped(serialize(startupRestore))

    return {
      play: (workshopId) =>
        control(Effect.gen(function* () {
          yield* clearRestoreBestEffort("explicit play")
          const item = yield* library.get(workshopId)
          const path = yield* library.playablePath(item)
          yield* powerOnDisplayIfKnownOff
          yield* mpv.play(item.workshop_id, path)
          yield* library.update(item.workshop_id, { last_played_at: Date.now() })
          yield* mpv.setDisplayMode(item.display_mode)
          return { ok: true, path }
        })),

      stopForIdle: () =>
        control(Effect.gen(function* () {
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
        })),

      displayOff: () =>
        control(stopAndPowerOff("display_off")),

      displayOn: () =>
        control(Effect.gen(function* () {
          yield* display.on().pipe(Effect.uninterruptible)
          const restored = yield* restoreSaved("display_on")
          return { ok: true, state: "on", ...restored }
        })),

      recovered: () => Stream.fromPubSub(recoveredPubSub),
    }
  })
)
