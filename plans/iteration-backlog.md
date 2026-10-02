# Iteration Backlog

This document tracks active development tasks and bug fixes.
Status markers: 📋 Todo, 🔨 In Progress, 🔒 Blocked (needs hardware).

## 🔒 Blocked (Hardware Required)
### BL-11 Phase 2 Worker NAS End-to-End 🔒
- Worker code is implemented (`packages/worker/`). Requires deploying the Docker image to a real Intel iGPU NAS to verify ffmpeg QSV detection, heartbeat, and progress reporting.

### BL-12 Smoke Test 🔒
- Verify playback rotation (sequential, shuffle) on a real Pi for memory leaks. Test sleep timer and display linkage on the physical TV.

## Changelog
- **[Completed] Unified play limit**: the sleep timer is gone; the play limit is the one stop timer, settable from the PlayerBar, the mobile sheet and Settings, with an ALWAYS (durable) or ONCE (this session only) mode. See [ADR 0012](../docs/adr/0012-one-play-limit-two-modes.md).
- **[Completed] Drop GitHub CI**: removed both workflows and disabled Actions for the repository; the machine gates (`bun test`, `bun run typecheck`, `bun run build`, `bash scripts/smoke-test-worker-image.sh`, `bun run test:e2e`) run locally via [the Development Guide](../docs/agents/development.md#validation). See [ADR 0011](../docs/adr/0011-local-machine-gates.md).
- **[Completed] BL-19 UI 重设计实现**: 15 张实现票(81040b7..ec26ac3)按 `.scratch/ui-redesign/spec.md` 全量落地——双主题 token 层、RailShell XOR 蒙版、功能性滚动条、liquid glass PlayerBar、Kare 1-bit 焦点带、ghost/VT 空间连续、界面声音层、Login/Setup 与移动端适配;验收记录 `.scratch/ui-redesign-impl/acceptance.md`,code-review 两轴评审发现已全部修复。
- **[Completed] BL-17 Transcoded Video Preview**: `GET /api/library/:id/stream` (Range/206) + Plyr `VideoPreview` overlay from Library cards. HEVC-only with a decode-failure notice. See `plans/preview-transcoded-video.md`.
- **[Completed] BL-18 Playwright E2E**: `library`, `player-bar`, `settings`, `shell` tests added (`activity` covers the merged downloads/transcode pages; stale `transcode.pw.ts` removed). `.github/workflows/e2e.yml` runs the suite on push/PR without blocking `ci.yml`.
- **[Completed] Storage Redesign**: Declarative Custom Directory (`storage.root`) + `@pwe/migrate`. SMB removed.
- **[Completed] Auth**: Better Auth + Passkey session guard.
- **[Completed] Player rotation & display linkage**: interval-driven rotation, auto-off timer, state restore.
- **[Completed] Vite 8**: Upgraded frontend to Vite 8.

