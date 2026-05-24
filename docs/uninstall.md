# Uninstall

There is no automatic uninstaller — the script would have to make destructive
decisions about your data. Run these manually in the order shown.

## 1. Stop the service

```bash
systemctl --user disable --now pi-wallpaper-engine.service
rm ~/.config/systemd/user/pi-wallpaper-engine.service
systemctl --user daemon-reload
```

## 2. Remove user data (optional — destroys your wallpaper library)

```bash
# Local media root. Edit to match config.paths.data_root if you customized it.
rm -rf ~/pi-wallpaper-engine-data

# Local SQLite state DB and transient storage credential files.
rm -rf ~/.local/state/pi-wallpaper-engine
```

If you used SMB storage, media may also exist under the **存放路径** configured
inside your share, for example `<share>/pi-wallpaper-engine/source` and
`<share>/pi-wallpaper-engine/optimized`. Delete those from the NAS only if you
want to destroy the remote wallpaper library too. The sentinel
`.pwe-mounted-root` can stay if other tools use the same share.

## 3. Remove the storage helper

```bash
sudo rm -f /usr/local/lib/pwe-storage-helper
sudo rm -f /etc/sudoers.d/pi-wallpaper-engine-storage
```

## 4. Remove the project directory

```bash
rm -rf ~/path/to/pi-wallpaper-engine
```

## 5. Disable linger (if you don't run any other user services)

```bash
sudo loginctl disable-linger "$USER"
```

## 6. Remove SteamCMD session (optional — kills login for ALL SteamCMD use)

```bash
rm -rf ~/Steam
rm -rf ~/.steam
```

## 7. Remove SteamCMD and box86 wrapper (optional)

```bash
sudo rm -f /usr/local/bin/steamcmd
rm -rf ~/.local/share/steamcmd
```

## 8. Uninstall apt packages (optional — only if no other app uses them)

The installer uses Valve's SteamCMD tarball through box86, not Debian's
`steamcmd` package.

```bash
sudo apt-get remove --purge mpv ffmpeg cifs-utils gnome-keyring libsecret-tools rsync box86 libc6:armhf
sudo rm -f /etc/apt/sources.list.d/box86.list
sudo rm -f /usr/share/keyrings/box86-archive-keyring.gpg
sudo dpkg --remove-architecture armhf
sudo apt-get autoremove
```

## 9. Remove Bun (optional)

```bash
rm -rf ~/.bun
```
