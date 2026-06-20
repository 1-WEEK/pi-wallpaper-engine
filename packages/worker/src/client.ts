import type { TranscodeJob } from "@pwe/shared"
import { createWriteStream } from "node:fs"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"

/**
 * Plain fetch client against the Pi backend's /api/transcode/* routes.
 * No Effect, no Elysia — kept minimal so the Worker container has a tiny
 * dependency footprint.
 *
 * Errors throw `WorkerHttpError` so the main loop can decide retry vs fatal.
 */

export class WorkerHttpError extends Error {
  readonly status: number
  readonly code: "network" | "auth" | "not_found" | "server" | "client" | "decode"

  constructor(
    message: string,
    status: number,
    code: WorkerHttpError["code"],
    options?: { cause?: unknown }
  ) {
    super(message, options)
    this.name = "WorkerHttpError"
    this.status = status
    this.code = code
  }
}

export interface WorkerClient {
  readonly claim: (workerName: string) => Promise<TranscodeJob | null>
  readonly downloadSource: (sourceUrl: string, destinationPath: string) => Promise<void>
  readonly heartbeat: (jobId: string) => Promise<boolean>
  readonly progress: (jobId: string, percent: number) => Promise<void>
  readonly uploadArtifact: (artifactUrl: string, artifactPath: string, durationMs: number) => Promise<void>
  readonly fail: (jobId: string, error: string) => Promise<void>
}

export interface WorkerClientConfig {
  readonly baseUrl: string
  readonly apiKey: string
  /** Optional override for fetch — useful in tests. */
  readonly fetchImpl?: typeof fetch
}

const trimSlash = (s: string) => s.replace(/\/+$/, "")

const resolveUrl = (base: string, pathOrUrl: string): string =>
  new URL(pathOrUrl, `${base}/`).toString()

export const createWorkerClient = (config: WorkerClientConfig): WorkerClient => {
  const base = trimSlash(config.baseUrl)
  const fetchImpl = config.fetchImpl ?? fetch

  const request = async (
    path: string,
    init: { method: "POST"; body?: unknown }
  ): Promise<Response> => {
    let res: Response
    try {
      res = await fetchImpl(`${base}${path}`, {
        method: init.method,
        headers: {
          "content-type": "application/json",
          "x-worker-key": config.apiKey,
        },
        body: init.body === undefined ? "{}" : JSON.stringify(init.body),
      })
    } catch (cause) {
      throw new WorkerHttpError(
        `Network failure calling ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
        0,
        "network",
        { cause }
      )
    }

    if (res.status === 401 || res.status === 403) {
      throw new WorkerHttpError(`Worker auth rejected by ${path} (${res.status})`, res.status, "auth")
    }
    if (res.status === 404) {
      throw new WorkerHttpError(`Resource missing: ${path}`, res.status, "not_found")
    }
    if (res.status >= 500) {
      const text = await res.text().catch(() => "")
      throw new WorkerHttpError(
        `Backend ${res.status} on ${path}: ${text.slice(0, 200)}`,
        res.status,
        "server"
      )
    }
    if (res.status >= 400) {
      const text = await res.text().catch(() => "")
      throw new WorkerHttpError(
        `Backend ${res.status} on ${path}: ${text.slice(0, 200)}`,
        res.status,
        "client"
      )
    }
    return res
  }

  const fetchAuthed = async (
    pathOrUrl: string,
    init: { method: "GET" | "PUT"; headers?: Record<string, string>; body?: BodyInit }
  ): Promise<Response> => {
    const path = resolveUrl(base, pathOrUrl)
    let res: Response
    try {
      res = await fetchImpl(path, {
        method: init.method,
        headers: {
          "x-worker-key": config.apiKey,
          ...(init.headers ?? {}),
        },
        body: init.body,
      })
    } catch (cause) {
      throw new WorkerHttpError(
        `Network failure calling ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
        0,
        "network",
        { cause }
      )
    }

    if (res.status === 401 || res.status === 403) {
      throw new WorkerHttpError(`Worker auth rejected by ${path} (${res.status})`, res.status, "auth")
    }
    if (res.status === 404) {
      throw new WorkerHttpError(`Resource missing: ${path}`, res.status, "not_found")
    }
    if (res.status >= 500) {
      const text = await res.text().catch(() => "")
      throw new WorkerHttpError(
        `Backend ${res.status} on ${path}: ${text.slice(0, 200)}`,
        res.status,
        "server"
      )
    }
    if (res.status >= 400) {
      const text = await res.text().catch(() => "")
      throw new WorkerHttpError(
        `Backend ${res.status} on ${path}: ${text.slice(0, 200)}`,
        res.status,
        "client"
      )
    }
    return res
  }

  return {
    claim: async (workerName) => {
      const res = await request("/api/transcode/claim", {
        method: "POST",
        body: { worker: workerName },
      })
      if (res.status === 204) return null
      const data = (await res.json().catch(() => null)) as TranscodeJob | null
      if (!data) return null
      return data
    },

    downloadSource: async (sourceUrl, destinationPath) => {
      const res = await fetchAuthed(sourceUrl, { method: "GET" })
      if (!res.body) {
        throw new WorkerHttpError(`Backend returned empty source body: ${sourceUrl}`, res.status, "decode")
      }
      await pipeline(
        Readable.fromWeb(res.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
        createWriteStream(destinationPath)
      )
    },

    heartbeat: async (jobId) => {
      try {
        await request(`/api/transcode/${encodeURIComponent(jobId)}/heartbeat`, {
          method: "POST",
        })
        return true
      } catch (e) {
        if (e instanceof WorkerHttpError && e.code === "not_found") return false
        throw e
      }
    },

    progress: async (jobId, percent) => {
      await request(`/api/transcode/${encodeURIComponent(jobId)}/progress`, {
        method: "POST",
        body: { progress: percent },
      })
    },

    uploadArtifact: async (artifactUrl, artifactPath, durationMs) => {
      await fetchAuthed(artifactUrl, {
        method: "PUT",
        headers: {
          "x-transcode-duration-ms": String(Math.max(0, Math.round(durationMs))),
        },
        body: Bun.file(artifactPath),
      })
    },

    fail: async (jobId, error) => {
      await request(`/api/transcode/${encodeURIComponent(jobId)}/fail`, {
        method: "POST",
        body: { error },
      })
    },
  }
}
