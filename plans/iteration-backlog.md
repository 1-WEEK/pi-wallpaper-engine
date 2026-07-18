# Iteration Backlog

This document tracks active development tasks and bug fixes.
Status markers: 📋 Todo, 🔨 In Progress, 🔒 Blocked (needs hardware).

## 🔒 Blocked (Hardware Required)
### BL-11 Phase 2 Worker NAS End-to-End 🔒
- Worker code is implemented (`packages/worker/`). Requires deploying the Docker image to a real Intel iGPU NAS to verify ffmpeg QSV detection, heartbeat, and progress reporting.

### BL-12 Smoke Test 🔒
- Verify playback rotation (sequential, shuffle) on a real Pi for memory leaks. Test sleep timer and display linkage on the physical TV.

## Changelog
- **[Completed] BL-17 Transcoded Video Preview**: `GET /api/library/:id/stream` (Range/206) + Plyr `VideoPreview` overlay from Library cards. HEVC-only with a decode-failure notice. See `plans/preview-transcoded-video.md`.
- **[Completed] BL-18 Playwright E2E**: `library`, `player-bar`, `settings`, `shell` tests added (`activity` covers the merged downloads/transcode pages; stale `transcode.pw.ts` removed). `.github/workflows/e2e.yml` runs the suite on push/PR without blocking `ci.yml`.
- **[Completed] Storage Redesign**: Declarative Custom Directory (`storage.root`) + `@pwe/migrate`. SMB removed.
- **[Completed] Auth**: Better Auth + Passkey session guard.
- **[Completed] Player rotation & display linkage**: interval-driven rotation, auto-off timer, state restore.
- **[Completed] Vite 8**: Upgraded frontend to Vite 8.

