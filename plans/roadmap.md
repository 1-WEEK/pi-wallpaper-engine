# Roadmap

Updated: 2026-06-06.

This roadmap reflects the current product direction: Phase 1 direct playback is
the active product, custom directory storage migration is implemented, and the
Phase 2 transcoding worker is implemented but not yet deployed on a real NAS.

## 1. Documentation Cleanup

Status: completed.

Goal: finish the current documentation reset and commit it cleanly.

- Keep `plans/pi-wallpaper-engine-spec.md` as the current v4 spec.
- Keep `plans/project-status-2026-05-27.md` as the latest status snapshot.
- Keep older implementation plans only when they explain real decisions or
  explicitly say they are not implemented yet.
- Split documentation commits into current status/spec/roadmap and
  operator/history cleanup.

## 2. Player And Display Linkage

Status: validated and completed.

Goal: make display power behavior follow the actual resource-saving intent.

- User stop starts a 30-second auto-off timer after stopping mpv.
- Manual display off calls `mpv.stop()` before turning the display off.
- A singleton `player_state` row records the wallpaper stopped for power saving.
- Display on restores that wallpaper from the beginning, then clears the
  restore state.
- Backend startup may auto-restore only when `display.status_command` reliably
  reports the display is on.

## 3. Storage Real-Device Validation

Goal: validate the implemented custom directory storage design on the real Pi setup with the real wallpaper library.

- Test storage UI directory picker functionality.
- Test migration between local storage and a custom user-defined path.
- Confirm downloads are blocked during migration.
- Confirm migration is rejected while playing from the source root.

## 4. Passkey Authentication

Goal: protect the Cloudflare Tunnel deployment with application-layer auth.

- Use the Better Auth + Passkey single-admin design in
  `plans/auth-passkey-betterauth.md`.
- Add an independent local `auth.db`.
- Keep `/api/health` and `/api/auth/*` public; protect business APIs and
  download WebSocket sessions.
- Keep Cloudflare Tunnel as the deployment path. Naked Tunnel exposure is a
  short-term accepted risk until this phase lands.

## 5. Phase 2 NAS Transcoding Worker

Status: implemented; not yet deployed or validated on a real NAS.

Goal: implement the deferred Worker architecture after auth is in place.

- [x] Pi-side `/api/transcode/*` routes (mounted when `PWE_WORKER_API_KEY` is set).
- [x] Runtime switches `TranscodeQueueNoop` → `TranscodeQueueLive` via `transcodeMode()`.
- [x] NAS Docker Worker against `WorkerProtocol` (`@pwe/worker`).
- [x] Heartbeat, progress, completion, failure, and retry behavior.
- [x] Transcode state surfaced on library cards.
- [ ] Deploy the Worker on a real NAS and validate an end-to-end transcode.
