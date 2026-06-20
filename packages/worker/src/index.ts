import { createWorkerClient, WorkerHttpError } from "./client.js"
import { detectEncoder, transcode } from "./ffmpeg.js"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"

interface RuntimeConfig {
  readonly backendUrl: string
  readonly apiKey: string
  readonly workerName: string
  readonly workDir: string
}

const requireEnv = (name: string): string => {
  const v = process.env[name]
  if (!v || v.trim().length === 0) {
    console.error(`✗ Missing required env var: ${name}`)
    process.exit(2)
  }
  return v
}

const loadConfig = (): RuntimeConfig => ({
  backendUrl: requireEnv("PWE_BACKEND_URL"),
  apiKey: requireEnv("PWE_WORKER_API_KEY"),
  workerName: process.env["PWE_WORKER_NAME"] ?? "worker",
  workDir: process.env["PWE_WORK_DIR"] ?? "/tmp/pwe-worker",
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const HEARTBEAT_INTERVAL_MS = 15_000
const IDLE_POLL_MS = 10_000
const NETWORK_BACKOFF_MS = 30_000

let running = true
process.on("SIGINT", () => {
  console.log("SIGINT — finishing current job and exiting…")
  running = false
})
process.on("SIGTERM", () => {
  console.log("SIGTERM — finishing current job and exiting…")
  running = false
})

const main = async () => {
  const config = loadConfig()
  const client = createWorkerClient({ baseUrl: config.backendUrl, apiKey: config.apiKey })

  console.log(`▶ pwe-worker "${config.workerName}" → ${config.backendUrl}`)
  console.log(`  work dir: ${config.workDir}`)

  // Detect encoder once at startup. Reuse for every job so we don't pay the
  // ~1s detection cost per claim.
  const encoderChoice = await detectEncoder()
  console.log(`  encoder: ${encoderChoice.kind} — ${encoderChoice.reason}`)

  while (running) {
    let job: Awaited<ReturnType<typeof client.claim>> = null
    try {
      job = await client.claim(config.workerName)
    } catch (e) {
      if (e instanceof WorkerHttpError && e.code === "auth") {
        console.error(`✗ Auth rejected (${e.status}). Check PWE_WORKER_API_KEY matches backend.`)
        process.exit(3)
      }
      console.warn(`claim() failed: ${(e as Error).message}; backing off ${NETWORK_BACKOFF_MS}ms`)
      await sleep(NETWORK_BACKOFF_MS)
      continue
    }

    if (!job) {
      await sleep(IDLE_POLL_MS)
      continue
    }

    console.log(`◆ Claimed job ${job.id} for workshop ${job.workshop_id}`)
    const jobDir = join(config.workDir, job.id)
    const sourcePath = join(jobDir, "source")
    const outputPath = join(jobDir, "output.mp4")

    const heartbeatTimer = setInterval(() => {
      client
        .heartbeat(job!.id)
        .then((ok) => {
          if (!ok) console.warn(`  heartbeat: job ${job!.id} no longer owned`)
        })
        .catch((e) => {
          console.warn(`  heartbeat error: ${(e as Error).message}`)
        })
    }, HEARTBEAT_INTERVAL_MS)

    try {
      await rm(jobDir, { recursive: true, force: true })
      await mkdir(jobDir, { recursive: true })
      await client.downloadSource(job.source_url, sourcePath)

      let lastReportedPct = 0
      const result = await transcode(job, {
        sourcePath,
        outputPath,
        encoder: encoderChoice.kind,
        onProgress: (pct) => {
          // Throttle: report every >= 5% to keep the backend write load low.
          if (pct - lastReportedPct < 5) return
          lastReportedPct = pct
          client.progress(job!.id, pct).catch((e) => {
            console.warn(`  progress(${pct}) failed: ${(e as Error).message}`)
          })
        },
      })

      await client.uploadArtifact(job.artifact_url, result.outputPath, result.durationMs)
      console.log(
        `✓ Completed ${job.id} (${result.encoderUsed}) — ${result.outputSize} bytes in ${result.durationMs}ms`
      )
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      console.warn(`✗ Job ${job.id} failed: ${message}`)
      try {
        await client.fail(job.id, message.slice(0, 4000))
      } catch (reportErr) {
        console.error(`  could not report failure: ${(reportErr as Error).message}`)
      }
    } finally {
      clearInterval(heartbeatTimer)
      await rm(jobDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  console.log("Worker stopped cleanly.")
}

main().catch((e) => {
  console.error("Fatal:", e)
  process.exit(1)
})
