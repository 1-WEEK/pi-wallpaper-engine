# Iteration Backlog

This document tracks active development tasks and bug fixes.
Status markers: 📋 Todo, 🔨 In Progress, 🔒 Blocked (needs hardware).

## P1: Missing Features
### BL-18 Complete Playwright E2E Tests 📋
- **Value**: Provide full UI interaction coverage for frontend routes.
- **Scope**:
  - `playwright.config.ts`, `fixtures.ts`, `helpers.ts`, and `browse.pw.ts` are done.
  - **Missing tests**: `library`, `downloads`, `player-bar`, `settings`, and `shell`.
  - **Missing CI**: Create `.github/workflows/e2e.yml` to run tests on push/PR without blocking `ci.yml`.

### BL-17 Transcoded Video Preview (Plyr) 📋
- **Value**: Allow users to preview transcoded videos in the browser directly from the Library, avoiding the need to test them on the physical TV via `mpv`.
- **Scope**:
  - Backend: `GET /api/library/:workshopId/stream` supporting HTTP 206 Partial Content (Range requests) for `optimized/` mp4 files.
  - Frontend: Import `plyr`. Add a `VideoPreview` component. Add a 'Preview' button on Library cards if `transcode_status === 'completed'`.
  - Constraints: Only HEVC playback. No H.264 fallback. If the browser lacks HEVC support, catch the `plyr` error and show a polite notice.

## 🔒 Blocked (Hardware Required)
### BL-11 Phase 2 Worker NAS End-to-End 🔒
- Worker code is implemented (`packages/worker/`). Requires deploying the Docker image to a real Intel iGPU NAS to verify ffmpeg QSV detection, heartbeat, and progress reporting.

### BL-12 Smoke Test 🔒
- Verify playback rotation (sequential, shuffle) on a real Pi for memory leaks. Test sleep timer and display linkage on the physical TV.

## Changelog
- **[Completed] Storage Redesign**: Declarative Custom Directory (`storage.root`) + `@pwe/migrate`. SMB removed.
- **[Completed] Auth**: Better Auth + Passkey session guard.
- **[Completed] Player rotation & display linkage**: interval-driven rotation, auto-off timer, state restore.
- **[Completed] Vite 8**: Upgraded frontend to Vite 8.

