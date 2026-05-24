# Optional: network storage (SMB)

By default, wallpapers live on the Pi's SD card at `~/pi-wallpaper-engine-data`.
If you want them on a NAS or any other SMB share instead, the app can manage the
mount and the data migration for you — no terminal, no `fstab`, no `mount`
commands.

## How it works

- `storage.mode` is either `local` (SD card) or `mounted_share` (SMB).
- The SQLite state DB is always kept locally at
  `~/.local/state/pi-wallpaper-engine/`, independent of `mode`.
- The SMB share is mounted by a privileged helper, with credentials stored in
  the system keyring (`Bun.secrets` → Secret Service on Linux).
- Media files can live in a relative folder inside the share, such as
  `pi-wallpaper-engine`, instead of at the share root.
- The app mounts exactly one share. Multi-connection management, custom mount
  options, and `fstab` entries are intentionally not part of the UI.
- Switching `mode` with an existing wallpaper library automatically **moves**
  the media files to the new location. The source is removed only after the
  copy is verified.

## One-time setup on the Pi

Run:

```bash
bash install-pi.sh
```

That installs:

- `rsync`, `cifs-utils`, `gnome-keyring`
- the privileged mount helper at `/usr/local/lib/pwe-storage-helper`
- a sudoers whitelist so the backend can mount and unmount through the helper

A desktop keyring such as `gnome-keyring` must be available in the session so
`Bun.secrets` can store the SMB password.

## Prepare the SMB share

At the root of the share, create the sentinel file the app expects:

```bash
touch .pwe-mounted-root
```

The backend refuses to mount a share that is missing this file — it's a guard
against silently writing into the wrong directory when a mount is misconfigured.
The media folder you set in the app is separate from this sentinel and is
created automatically after the share is mounted.

## Configure it in the app

Open **Settings** → **存储位置** and:

1. Fill in **网络地址**, **共享名**, **存放路径**, **用户名**, **密码** and click **保存网络存储设置**.
2. Click **网络存储** in the mode toggle.

If the library is empty the switch is instant. If the library has wallpapers,
the app asks you to confirm and then moves the files in the background. A
progress bar shows `moved / total`, with a **取消** button.

The app stores: server, share, username, and the relative media path inside the
share. Mount options (`vers=3.0`, charset, uid/gid, file/dir modes) are fixed
safe defaults inside the backend. The password is in `Bun.secrets`, never in
`config.json`.

The media path may be empty to use the share root, but `pi-wallpaper-engine` is
recommended so the app writes under `<share>/pi-wallpaper-engine/source` and
`<share>/pi-wallpaper-engine/optimized`.

Validation is intentionally strict:

- server and share cannot contain slashes, newlines, or NUL bytes
- media path must be relative inside the share
- media path cannot contain `..`, `.`, empty segments, backslashes, newlines, or
  NUL bytes

## Runtime behavior

- The backend starts even if the SMB share is unreachable.
- When `mode = mounted_share`, the backend retries the mount every 30s, so a NAS
  that boots slower than the Pi or briefly drops will come back automatically.
- If storage is unavailable, new downloads and new play requests return `503`.
- New downloads are blocked while a migration is running (so files added mid-move
  aren't missed).
- Migration is a move, not a copy: the source is deleted only after the
  destination passes a `rsync --dry-run` integrity check and the target mode has
  been written to config. A failure or cancel before commit leaves the source
  intact and the mode unchanged.
- A migration request while mpv is playing a file from the source root is
  rejected with `409`; stop playback first.

## Switch back to local

In **Settings**, click **本机 SD 卡**. With an existing library the app
migrates the files back from the SMB share to the SD card (after a free-space
check), then unmounts the share. Without enough free space on the SD card the
switch is rejected before any move starts.

## Replacing the SMB device

To point the app at a different SMB server:

1. Switch back to **本机 SD 卡** (this moves your library to the SD card).
2. Edit the SMB fields, including **存放路径**, and **保存**.
3. Switch to **网络存储** (this moves the library to the new share).

Editing credentials directly while in `mounted_share` mode saves them for the
next reconnect. Editing the server, share, or media path while a library
already exists is rejected; switch back to local first so the files move safely.
