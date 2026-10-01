import { Context, Effect, Layer, PubSub, Queue, Stream } from "effect"
import { Logger } from "./Logger.js"
import { Storage } from "./Storage.js"

/**
 * One observation of the active media root. Backend-local on purpose: the HTTP
 * surface for this condition is the existing `status.storage` block, so this
 * type never crosses into `@pwe/shared`.
 */
export interface MediaRootStatus {
  readonly available: boolean
  readonly root: string
  /** Null exactly when `available` is true. Names the causing path. */
  readonly reason: string | null
}

/**
 * How long the watch waits before its first probe, so a mount attempt that was
 * already in flight when the backend started can finish. Short enough that a
 * late share is noticed before the user has time to distrust the screen.
 */
export const STARTUP_PROBE_DELAY_MS = 3_000

/**
 * Idle cadence while the root is reachable.
 *
 * It is not a bare idle tick: every probe that finds the root reachable is
 * republished as a retry opportunity, so this is also the worst-case delay
 * before a recovery retry runs after a failed one. A 1-minute bound keeps a
 * late mount from leaving the screen black for longer than a minute, and costs
 * one `access(2)` a minute. Deliberately not faster: the ticket requires that
 * re-evaluation stays bounded and cheap, not that it is tight.
 */
export const AVAILABLE_TICK = "1 minute"

/**
 * Ceiling on how long the watch sits idle while the root is unreachable. A
 * share that is down for days is probed at most ~5 times a minute; a share that
 * comes back is noticed within this window.
 */
export const UNAVAILABLE_BACKOFF_CAP = "12 seconds"

/**
 * Folder-level watch over the active media root.
 *
 * Ticket 01 of `.scratch/playback-mount-resilience`. The media root is a
 * network mount whose unit can come and go while the backend runs; `Storage`
 * answers "is it reachable *right now*" and nothing else, so anything that must
 * react to the root coming back needs its own signal. This service owns that
 * signal.
 *
 * It reads through `Storage` rather than configuration on purpose: the active
 * root is mutable (`Storage.saveRoot` is called by the root-switch route and by
 * `Migrate`), so a path captured from config at construction would be stale
 * after a switch or migration and the watch would quietly stop noticing the
 * live root.
 *
 * Callers: `PlayerPower`, which retries a wallpaper it had to hold once the
 * share answers again.
 *
 * Cost discipline, per the ticket: the loop only probes on a timer while the
 * root is reachable (one `access(2)` a minute) or unreachable (capped at
 * `UNAVAILABLE_BACKOFF_CAP`), and `probeNow()` collapses that wait instead of
 * adding a second prober. Nothing privileged runs here.
 */
export interface MediaRootWatchImpl {
  /**
   * One emission per probe that found the media root reachable — every probe,
   * not just the one that follows an outage.
   *
   * That distinction is the whole point. A recovery retry can fail while the
   * root is perfectly reachable (mpv was mid-restart, the file was still
   * syncing to the share), and a transition-only signal would leave that
   * wallpaper held until the *next* outage. Emitting on reachability makes the
   * retry idempotent and self-healing while adding no timer: the cadence is the
   * probe loop's, which already exists.
   */
  readonly availableProbes: () => Stream.Stream<MediaRootStatus>
  /** Re-probe immediately instead of waiting out the current sleep. */
  readonly probeNow: () => Effect.Effect<void>
}

export class MediaRootWatch extends Context.Service<MediaRootWatch, MediaRootWatchImpl>()(
  "MediaRootWatch"
) {}

export const MediaRootWatchLive = Layer.effect(
  MediaRootWatch,
  Effect.gen(function* () {
    const storage = yield* Storage
    const logger = yield* Logger

    const availableProbes = yield* PubSub.unbounded<MediaRootStatus>()
    const wake = yield* Queue.unbounded<void>()

    // Single writer: this loop is the only fiber that probes, so a plain local
    // is enough to keep the log to one line per real change of verdict.
    let last: MediaRootStatus | null = null

    const probeAndPublish = Effect.gen(function* () {
      // One source of truth: whatever `GET /api/storage` would report is what
      // this watch reacts to, including the wording of the failure.
      const state = yield* storage.status()
      const status: MediaRootStatus = {
        available: state.available,
        root: state.data_root,
        reason: state.last_error,
      }
      if (status.available) yield* PubSub.publish(availableProbes, status)
      if (last && last.available === status.available && last.reason === status.reason) {
        return status
      }
      last = status
      yield* logger.info(
        status.available
          ? `Media root available at ${status.root}`
          : `Media root unavailable: ${status.reason}`
      )
      return status
    })

    const sleepOrWake = (duration: Parameters<typeof Effect.sleep>[0]) =>
      Queue.take(wake).pipe(Effect.timeout(duration), Effect.ignore)

    const loop = Effect.gen(function* () {
      yield* Effect.sleep(STARTUP_PROBE_DELAY_MS)
      while (true) {
        const status = yield* probeAndPublish
        yield* sleepOrWake(status.available ? AVAILABLE_TICK : UNAVAILABLE_BACKOFF_CAP)
      }
    }).pipe(
      Effect.catchCause((cause) => logger.error(`MediaRootWatch loop stopped: ${String(cause)}`)),
      Effect.ensuring(logger.info("MediaRootWatch stopped"))
    )

    yield* Effect.forkScoped(loop)
    yield* logger.info(
      `MediaRootWatch started (first probe in ${STARTUP_PROBE_DELAY_MS}ms, unreachable retry every ${UNAVAILABLE_BACKOFF_CAP})`
    )

    return {
      availableProbes: () => Stream.fromPubSub(availableProbes),
      probeNow: () => Queue.offer(wake, undefined).pipe(Effect.asVoid),
    }
  })
)
