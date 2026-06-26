import { existsSync } from "node:fs"
import { mkdir, rm } from "node:fs/promises"

export type MigrateFailureCode = "Copy" | "Verify" | "Cancelled"

export class MigrateFailure extends Error {
  readonly code: MigrateFailureCode
  constructor(code: MigrateFailureCode, message: string) {
    super(message)
    this.name = "MigrateFailure"
    this.code = code
  }
}

// rsync output and number formatting must be locale-independent so progress
// lines and itemized diffs parse the same on every host.
const RSYNC_ENV = { ...process.env, LC_ALL: "C" }

/**
 * Total size of `dir` in bytes. Returns 0 if the directory does not exist.
 */
export async function estimateSize(dir: string): Promise<number> {
  if (!existsSync(dir)) return 0
  const isMac = process.platform === "darwin"
  const proc = Bun.spawn(isMac ? ["du", "-sk", dir] : ["du", "-sb", dir], {
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
  })
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  if (code !== 0) return 0
  const first = stdout.trim().split(/\s+/)[0]
  const n = Number(first)
  if (!Number.isFinite(n)) return 0
  return isMac ? n * 1024 : n
}

const runRsyncCopy = async (
  from: string,
  to: string,
  onProgress: ((movedBytes: number) => void) | undefined,
  signal: AbortSignal | undefined
): Promise<void> => {
  // `-r` only: copy contents recursively without preserving perms/owner/times.
  // CIFS mounts enforce their own uid/gid/modes, so preserving metadata both
  // fails and is pointless. `--size-only` keeps re-runs idempotent (a fully
  // copied file is skipped); `--partial` resumes a half-copied file.
  const isMac = process.platform === "darwin"
  const progressFlag = isMac ? "--progress" : "--info=progress2"
  const proc = Bun.spawn(
    ["rsync", "-r", "--partial", "--size-only", progressFlag, `${from}/`, `${to}/`],
    { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: RSYNC_ENV }
  )

  const onAbort = () => proc.kill()
  signal?.addEventListener("abort", onAbort)
  const stderrPromise = new Response(proc.stderr).text()

  try {
    const decoder = new TextDecoder()
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
    let pending = ""
    let lastEmit = 0
    // rsync prints `--info=progress2` lines with thousands separators even
    // under LC_ALL=C, e.g. "5,000,000 100% ...". Strip the commas.
    const handleSegment = (segment: string): void => {
      const match = segment.trim().match(/^([\d,]+)\s+\d+%/)
      if (match && match[1] && onProgress) {
        const now = Date.now()
        if (now - lastEmit > 500) {
          lastEmit = now
          onProgress(Number(match[1].replace(/,/g, "")))
        }
      }
    }
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      pending += decoder.decode(value, { stream: true })
      const segments = pending.split(/[\r\n]/)
      pending = segments.pop() ?? ""
      for (const segment of segments) handleSegment(segment)
    }
    if (pending) handleSegment(pending)

    const code = await proc.exited
    const stderr = (await stderrPromise).trim()
    if (signal?.aborted) {
      throw new MigrateFailure("Cancelled", "Migration cancelled")
    }
    if (code !== 0) {
      throw new MigrateFailure("Copy", `rsync copy exited ${code}: ${stderr || "(no output)"}`)
    }
  } finally {
    signal?.removeEventListener("abort", onAbort)
  }
}

const verifyCopy = async (from: string, to: string): Promise<void> => {
  // Dry-run itemized diff. `--size-only` keeps this CIFS-safe (mtime drifts on
  // CIFS would otherwise show false differences). A line starting with `>f`
  // means a file's content is still missing or wrong at the destination.
  const proc = Bun.spawn(["rsync", "-rni", "--size-only", `${from}/`, `${to}/`], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: RSYNC_ENV,
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) {
    throw new MigrateFailure("Verify", `rsync verify exited ${code}: ${stderr.trim() || "(no output)"}`)
  }
  const mismatched = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(">f"))
  if (mismatched.length > 0) {
    throw new MigrateFailure(
      "Verify",
      `${mismatched.length} file(s) did not copy correctly`
    )
  }
}

export interface TreePairOptions {
  /** Source directory. If it does not exist, the move is a no-op. */
  readonly from: string
  /** Destination directory. Created if missing. */
  readonly to: string
  /** Reports bytes copied so far for this directory pair. */
  readonly onProgress?: (movedBytes: number) => void
  readonly signal?: AbortSignal
}

export type MoveTreeOptions = TreePairOptions

export async function copyTree(opts: TreePairOptions): Promise<void> {
  const { from, to, onProgress, signal } = opts
  if (!existsSync(from)) return
  if (signal?.aborted) {
    throw new MigrateFailure("Cancelled", "Migration cancelled")
  }

  await mkdir(to, { recursive: true })
  await runRsyncCopy(from, to, onProgress, signal)
}

export async function verifyTree(opts: Pick<TreePairOptions, "from" | "to">): Promise<void> {
  const { from, to } = opts
  if (!existsSync(from)) return
  await verifyCopy(from, to)
}

export async function removeTree(dir: string): Promise<void> {
  if (!existsSync(dir)) return
  await rm(dir, { recursive: true, force: true })
}

/**
 * Move a directory tree: copy `from` into `to`, verify the copy is complete,
 * then delete `from`. The source is removed only after verification passes, so
 * any failure leaves the source intact. Throws {@link MigrateFailure}.
 */
export async function moveTree(opts: MoveTreeOptions): Promise<void> {
  await copyTree(opts)
  await verifyTree(opts)
  await removeTree(opts.from)
}
