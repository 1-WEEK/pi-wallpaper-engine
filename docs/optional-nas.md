# Optional: NAS storage and Phase 2 transcoding

Phase 1 stores everything locally at `~/pi-wallpaper-engine-data/`. If you have a
NAS and want to:

- Avoid filling up the Pi's microSD with large 4K source files
- Prepare for Phase 2 (transcoding worker running on the NAS)

…then point `paths.data_root` in `config.json` at a CIFS/NFS mount of a NAS share.

## CIFS mount example

```bash
sudo mkdir -p /mnt/nas/wallpapers
sudo tee /etc/cifs-creds >/dev/null <<EOF
username=your_nas_user
password=your_nas_password
EOF
sudo chmod 600 /etc/cifs-creds

echo "//<nas-ip>/wallpapers /mnt/nas/wallpapers cifs credentials=/etc/cifs-creds,uid=$(id -u),gid=$(id -g),iocharset=utf8,nofail 0 0" | sudo tee -a /etc/fstab

sudo mount -a
```

Then in `config.json`:

```json
"paths": {
  "data_root": "/mnt/nas/wallpapers",
  ...
}
```

Restart the service: `systemctl --user restart pi-wallpaper-engine`.

If the mount is required for the service to start, add this to
`~/.config/systemd/user/pi-wallpaper-engine.service`:

```ini
[Unit]
RequiresMountsFor=/mnt/nas/wallpapers
```

## Phase 2: NAS transcoding worker

Not implemented yet. When it exists, the worker will run as a Docker container
on the NAS, share the same filesystem mount that the Pi sees, and pull
transcoding jobs from the Pi backend. See `packages/worker/README.md` and
`packages/shared/src/schema/WorkerProtocol.ts` for the planned contract.
