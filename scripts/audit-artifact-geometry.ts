#!/usr/bin/env bun
/**
 * Geometry audit for optimized artifacts.
 *
 * Answers one question per completed library row: was this artifact made by
 * cropping the source to the configured screen aspect ratio, or by stretching
 * the whole source into the target box? The stretched kind is the bug that
 * shipped on 2026-08-25 and sat in the library for over a month, because
 * nothing in the system looked at the picture itself.
 *
 * Why not container metadata: a stretched artifact is still 1200x1080 SAR 1:1
 * DAR 10:9, exactly like a correct one. `display_aspect_ratio` is identical in
 * both cases, so the only signal that survives is the pixels. This script
 * renders two references from the *source* at the same timestamp — a
 * crop-to-fill render and a stretch render — and asks which one the artifact's
 * actual frame looks like, by SSIM. The higher SSIM wins.
 *
 * Read-only: it never transcodes, never writes to the media root, and never
 * touches the database (the DB is opened readonly). Frame PNGs go to a temp
 * directory that is removed on exit, including on error.
 *
 * Usage:  bun scripts/audit-artifact-geometry.ts [--json] [--limit N]
 * Exit:   0 when no artifact is classified `stretched`, 1 when any is, so a
 *         cron/systemd timer can use the exit status as the tripwire.
 */
import { Database } from "bun:sqlite"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expandHome } from "../packages/backend/src/paths.js"
import { resolveDbPath } from "../packages/backend/src/statePath.js"

// --- config loading (same convention as preflight.ts / paths.ts) ------------

const CONFIG_PATH =
  process.env["PWE_CONFIG"] ?? resolve(homedir(), ".config/pi-wallpaper-engine/config.json")

if (!existsSync(CONFIG_PATH)) {
  console.error(`config not found: ${CONFIG_PATH} (set PWE_CONFIG to override)`)
  process.exit(2)
}

type Json = Record<string, unknown>
const config = JSON.parse(await Bun.file(CONFIG_PATH).text()) as Json
const paths = (config["paths"] ?? {}) as Json
const storage = (config["storage"] ?? {}) as Json
const screen = (config["screen"] ?? {}) as Json

const dataRoot = storage["root"] ?? paths["data_root"]
if (typeof dataRoot !== "string" || dataRoot.length === 0) {
  console.error(`config has neither storage.root nor paths.data_root: ${CONFIG_PATH}`)
  process.exit(2)
}
const MEDIA_ROOT = expandHome(dataRoot)

const width = screen["width"]
const height = screen["height"]
if (typeof width !== "number" || typeof height !== "number" || width <= 0 || height <= 0) {
  console.error(`config screen.width/height must be positive numbers: ${CONFIG_PATH}`)
  process.exit(2)
}
const TARGET_W = width
const TARGET_H = height

const DB_PATH = resolveDbPath()

// --- verdict thresholds -----------------------------------------------------

// Which side wins is decided by the *normalized* difference, never by the raw
// SSIM difference and never by a bare comparison of the two scores.
//
// The raw difference cannot be a fixed threshold: how close the two references
// score depends on the frame. On a busy 16:9 game scene they look nothing alike
// and the correct reference beats the other by +0.5; on a flat, slowly-panning
// or near-square frame the two references overlap almost completely (rho up to
// 0.98) and even the true winner wins by only +0.02. A threshold tuned for the
// first calls the second indeterminate; one tuned for the second misclassifies
// ordinary encoder noise on the first.
//
// So the mean raw difference is divided by the mean separation of the two
// references themselves, 1 - rho. The result is dimensionless: "+0.9" means the
// artifact frame sits 90% of the way from the losing reference to the winning
// one, whatever the frame. Measured on ground truth (sources spanning 16:9,
// 4:3 and square, each re-encoded once by crop and once by stretch, at the
// worker's settings) the true verdicts land at |normalized| 0.92 .. 0.99, and
// the raw differences for those same cases span 0.02 .. 0.51 — the normalization
// collapses that 25x spread onto one scale.
//
// 0.5 sits in a wide empty band between noise and signal: a non-match is near
// 0 (the artifact resembles neither reference), the weakest true match observed
// is 0.92. Nothing can be misclassified between those two numbers, and the
// margin cannot pass a stretched artifact: a stretched file's frame *is* the
// stretch reference re-encoded, so it scores ~1.0 toward stretch and ~rho toward
// crop, giving normalized ~-1 by construction whenever the two references are
// distinguishable enough for re-encoding noise not to dominate (rho < ~0.95).
const NORMALIZED_MARGIN = 0.5

// A verdict additionally requires that the winning reference actually *looks
// like* the frame. The normalization is only meaningful when one side genuinely
// wins: if the artifact matches neither reference (re-encoded from a different
// cut, a truncated or black file), the two near-zero differences are noise and
// their ratio is noise too. An exact resize of the same frame scores ~0.9+, so
// 0.6 is well under every true match observed and well over any mismatch.
const MATCH_FLOOR = 0.6

// --- probe timestamps -------------------------------------------------------

// One frame decides nothing: a scene cut, a still title card, or a fade at the
// identical instant on both files can make a single sample unrepresentative or
// pathological. We sample every item at two timestamps and average the two
// scores. 3s skips the lead-in (black frames, logo cards) that many workshop
// wallpapers open with; the second sample is 70% into the common span, far
// enough from the first to be a different scene, but never the very last frame,
// which is the most likely to be missing or truncated in a clipped artifact.
const EARLY_TS = 3

// Sources shorter than 1s are sampled at their first frame — any other
// timestamp has no frame to decode. Otherwise both probes are used. The pair is
// clamped to the *shorter* of the two files: an artifact may be shorter than
// its source (the worker's clip/loop handling, a clipped upload), and seeking
// past the artifact's last frame renders nothing at all, which would otherwise
// turn every such item into a spurious `failed`. Clamping to the same span for
// both files also keeps the artifact frame and the two references at the same
// instant, so the comparison stays like-for-like.
const timestamps = (sourceDuration: number | null, artifactDuration: number | null): number[] => {
  const span = Math.min(sourceDuration ?? Number.POSITIVE_INFINITY, artifactDuration ?? Number.POSITIVE_INFINITY)
  if (!Number.isFinite(span) || span <= 1) return [0]
  const clamp = (t: number) => Number(Math.max(0, Math.min(t, span - 0.5)).toFixed(3))
  const early = clamp(EARLY_TS)
  const late = clamp(span * 0.7)
  return early === late ? [early] : [early, late]
}

// --- process helpers (Bun.spawn, as in preflight.ts) ------------------------

const run = async (cmd: string[]): Promise<{ code: number; stderr: string }> => {
  const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe", stdin: "ignore" })
  const stderr = await new Response(proc.stderr).text()
  return { code: await proc.exited, stderr }
}

const durationOf = async (file: string): Promise<number | null> => {
  const proc = Bun.spawn(
    [
      "ffprobe",
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=nw=1:nk=1",
      file,
    ],
    { stdout: "pipe", stderr: "ignore", stdin: "ignore" }
  )
  const out = await new Response(proc.stdout).text()
  await proc.exited
  const parsed = Number.parseFloat(out.trim())
  return Number.isFinite(parsed) ? parsed : null
}

const ssim = async (reference: string, actual: string): Promise<number | null> => {
  const { code, stderr } = await run([
    "ffmpeg",
    "-hide_banner",
    "-nostats",
    "-i",
    reference,
    "-i",
    actual,
    "-lavfi",
    "ssim",
    "-f",
    "null",
    "-",
  ])
  if (code !== 0) return null
  const m = /All:([0-9.]+)/.exec(stderr)
  return m ? Number.parseFloat(m[1] as string) : null
}

const grabFrame = async (
  input: string,
  at: number,
  out: string,
  filter: string | null
): Promise<boolean> => {
  const args = ["ffmpeg", "-y", "-v", "error", "-ss", String(at), "-i", input, "-frames:v", "1"]
  if (filter !== null) args.push("-vf", filter)
  args.push(out)
  const { code } = await run(args)
  return code === 0 && existsSync(out)
}

// --- flags ------------------------------------------------------------------

const args = process.argv.slice(2)
const asJson = args.includes("--json")
const limitIdx = args.indexOf("--limit")
const limit = limitIdx === -1 ? null : Number.parseInt(args[limitIdx + 1] ?? "", 10)
if (limitIdx !== -1 && (!Number.isFinite(limit) || (limit as number) <= 0)) {
  console.error("--limit needs a positive integer")
  process.exit(2)
}
if (args.includes("--help") || args.includes("-h")) {
  console.log("usage: bun scripts/audit-artifact-geometry.ts [--json] [--limit N]")
  process.exit(0)
}
if (Bun.which("ffmpeg") === null || Bun.which("ffprobe") === null) {
  console.error("ffmpeg/ffprobe not found on PATH")
  process.exit(2)
}

// --- rows -------------------------------------------------------------------

type Verdict = "crop" | "stretched" | "indeterminate"

type Row = { workshop_id: string; source_path: string; transcoded_path: string }

const db = new Database(DB_PATH, { readonly: true })
const rows = db
  .query(
    `SELECT workshop_id, source_path, transcoded_path
       FROM library
      WHERE transcode_status = 'completed'
        AND transcoded_path IS NOT NULL
        AND transcoded_path <> ''
      ORDER BY workshop_id`
  )
  .all() as Row[]
db.close()

const selected = limit === null ? rows : rows.slice(0, limit)

// --- audit ------------------------------------------------------------------

const CROP = `crop=w='min(iw,ih*${TARGET_W}/${TARGET_H})':h='min(ih,iw*${TARGET_H}/${TARGET_W})',scale=${TARGET_W}:${TARGET_H}`
const STRETCH = `scale=${TARGET_W}:${TARGET_H}`

type Result = {
  workshopId: string
  verdict: Verdict | "skipped" | "failed"
  cropSsim: number | null
  stretchSsim: number | null
  normalized: number | null
  samples: { at: number; crop: number | null; stretch: number | null; separation: number | null }[]
  note?: string
}

const dir = mkdtempSync(join(tmpdir(), "pwe-geometry-audit-"))
const cleanup = () => rmSync(dir, { recursive: true, force: true })
process.on("exit", cleanup)
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    cleanup()
    process.exit(130)
  })
}

const results: Result[] = []

for (const row of selected) {
  const source = resolve(MEDIA_ROOT, row.source_path)
  const artifact = resolve(MEDIA_ROOT, row.transcoded_path)

  if (!existsSync(source)) {
    results.push({
      workshopId: row.workshop_id,
      verdict: "skipped",
      cropSsim: null,
      stretchSsim: null,
      normalized: null,
      samples: [],
      note: `source missing: ${source}`,
    })
    continue
  }
  if (!existsSync(artifact)) {
    results.push({
      workshopId: row.workshop_id,
      verdict: "skipped",
      cropSsim: null,
      stretchSsim: null,
      normalized: null,
      samples: [],
      note: `artifact missing: ${artifact}`,
    })
    continue
  }

  const [sourceDuration, artifactDuration] = await Promise.all([
    durationOf(source),
    durationOf(artifact),
  ])
  const ats = timestamps(sourceDuration, artifactDuration)
  const samples: Result["samples"] = []
  let error: string | null = null

  for (const at of ats) {
    const cropPng = join(dir, `${row.workshop_id}-${at}-crop.png`)
    const stretchPng = join(dir, `${row.workshop_id}-${at}-stretch.png`)
    const actualPng = join(dir, `${row.workshop_id}-${at}-actual.png`)
    const cropOk = await grabFrame(source, at, cropPng, CROP)
    const stretchOk = await grabFrame(source, at, stretchPng, STRETCH)
    const actualOk = await grabFrame(artifact, at, actualPng, null)
    if (!cropOk || !stretchOk || !actualOk) {
      error = `ffmpeg could not render frames at ${at}s (source ${cropOk ? "ok" : "no"} / artifact ${actualOk ? "ok" : "no"})`
      break
    }
    const cropSsim = await ssim(cropPng, actualPng)
    const stretchSsim = await ssim(stretchPng, actualPng)
    // How far apart the two references themselves are. On a busy frame they
    // look nothing alike (rho << 1) and the winner is obvious; on a flat or
    // slowly-panning frame they overlap heavily and the raw difference between
    // the two scores shrinks in proportion. Dividing by this gap turns the
    // decision into "which reference wins, relative to how different they are",
    // which is what makes one threshold work across the whole library.
    const separation = await ssim(cropPng, stretchPng)
    if (cropSsim === null || stretchSsim === null || separation === null) {
      error = `ssim failed at ${at}s`
      break
    }
    samples.push({ at, crop: cropSsim, stretch: stretchSsim, separation })
    rmSync(cropPng, { force: true })
    rmSync(stretchPng, { force: true })
    rmSync(actualPng, { force: true })
  }

  if (samples.length === 0 || error !== null) {
    results.push({
      workshopId: row.workshop_id,
      verdict: "failed",
      cropSsim: null,
      stretchSsim: null,
      normalized: null,
      samples,
      note: error ?? "no usable frame",
    })
    continue
  }

  let cropSum = 0
  let stretchSum = 0
  let spanSum = 0
  for (const s of samples) {
    cropSum += s.crop as number
    stretchSum += s.stretch as number
    spanSum += 1 - (s.separation as number)
  }
  const cropMean = cropSum / samples.length
  const stretchMean = stretchSum / samples.length
  const normalized = spanSum > 1e-6 ? (cropMean - stretchMean) / (spanSum / samples.length) : 0
  const best = Math.max(cropMean, stretchMean)

  let verdict: Verdict
  if (best < MATCH_FLOOR) verdict = "indeterminate"
  else if (normalized >= NORMALIZED_MARGIN) verdict = "crop"
  else if (normalized <= -NORMALIZED_MARGIN) verdict = "stretched"
  else verdict = "indeterminate"

  results.push({
    workshopId: row.workshop_id,
    verdict,
    cropSsim: cropMean,
    stretchSsim: stretchMean,
    normalized,
    samples,
    // Flag the case a bare threshold would hide: the frame matches the other
    // reference better by a hair, i.e. suspicious but not decisively wrong.
    ...(verdict === "indeterminate"
      ? { note: `ambiguous: normalized ${normalized.toFixed(3)} inside +/-${NORMALIZED_MARGIN}` }
      : {}),
  })
}

const counts = {
  crop: results.filter((r) => r.verdict === "crop").length,
  stretched: results.filter((r) => r.verdict === "stretched").length,
  indeterminate: results.filter((r) => r.verdict === "indeterminate").length,
  skipped: results.filter((r) => r.verdict === "skipped").length,
  failed: results.filter((r) => r.verdict === "failed").length,
}

const fmt = (v: number | null) => (v === null ? "   n/a  " : v.toFixed(4))
const fmtNorm = (v: number | null) =>
  v === null ? "   n/a  " : (v >= 0 ? "+" : "") + v.toFixed(3)

if (asJson) {
  console.log(
    JSON.stringify(
      {
        mediaRoot: MEDIA_ROOT,
        target: { width: TARGET_W, height: TARGET_H },
        thresholds: { normalizedMargin: NORMALIZED_MARGIN, matchFloor: MATCH_FLOOR },
        counts,
        results: results.map((r) => ({
          workshopId: r.workshopId,
          verdict: r.verdict,
          cropSsim: r.cropSsim,
          stretchSsim: r.stretchSsim,
          normalized: r.normalized,
          samples: r.samples,
          ...(r.note === undefined ? {} : { note: r.note }),
        })),
      },
      null,
      2
    )
  )
} else {
  console.log(
    `artifact geometry audit — ${MEDIA_ROOT} — target ${TARGET_W}x${TARGET_H} ` +
      `(normalized margin ${NORMALIZED_MARGIN}, match floor ${MATCH_FLOOR})\n`
  )
  console.log("workshop_id    verdict          crop    stretch   normalized")
  console.log("─".repeat(61))
  for (const r of results.sort((a, b) => a.workshopId.localeCompare(b.workshopId))) {
    console.log(
      `${r.workshopId.padEnd(14)} ${r.verdict.padEnd(15)} ${fmt(r.cropSsim)}  ${fmt(r.stretchSsim)}  ` +
        `${fmtNorm(r.normalized)}` +
        (r.note === undefined ? "" : `   (${r.note})`)
    )
  }
  console.log("")
  console.log(
    `summary: ${results.length} checked — ${counts.crop} crop, ${counts.stretched} stretched, ` +
      `${counts.indeterminate} indeterminate, ${counts.skipped} skipped, ${counts.failed} failed`
  )
}

process.exit(counts.stretched > 0 ? 1 : 0)
