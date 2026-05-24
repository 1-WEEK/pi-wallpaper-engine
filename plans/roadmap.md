# Roadmap

Updated: 2026-05-24.

This roadmap reflects the current product direction: Phase 1 direct playback is
the active product, SMB storage is implemented, and Phase 2 transcoding remains
planned after the deployed system is safer and better validated.

## 1. Documentation Cleanup

Goal: finish the current documentation reset and commit it cleanly.

- Keep `plans/pi-wallpaper-engine-spec.md` as the current v4 spec.
- Keep `plans/project-status-2026-05-24.md` as the latest status snapshot.
- Keep older implementation plans only when they explain real decisions or
  explicitly say they are not implemented yet.
- Split documentation commits into current status/spec/roadmap and
  operator/history cleanup.

## 2. Player And Display Linkage

Goal: make display power behavior follow the actual resource-saving intent.

- User stop starts a 30-second auto-off timer.
- Auto-off and manual display off both call `mpv.stop()` before turning the
  display off.
- A singleton `player_state` row records the wallpaper stopped for power saving.
- Display on restores that wallpaper from the beginning, then clears the
  restore state.
- Backend startup may auto-restore only when `display.status_command` reliably
  reports the display is on.

## 3. SMB Real-Device Validation

Goal: validate the implemented storage design on the real Pi/NAS setup with the
real wallpaper library.

- Test sentinel validation and `smb.path` media directory creation.
- Test local to SMB migration and SMB to local migration.
- Confirm downloads are blocked during migration.
- Confirm migration is rejected while playing from the source root.
- Confirm NAS disconnect and reconnect recover through the reconcile loop.

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

Goal: implement the deferred Worker architecture after auth is in place.

- Wire Pi-side `/api/transcode/*` routes.
- Switch runtime from `TranscodeQueueNoop` to the live queue when ready.
- Implement the NAS Docker Worker against `WorkerProtocol`.
- Add heartbeat, progress, completion, failure, and retry behavior.
- Surface transcode state in the library and task UI.
