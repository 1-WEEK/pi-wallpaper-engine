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
# Current media root. Edit to match config.paths.data_root or storage.root.
rm -rf ~/pi-wallpaper-engine-data

# Local SQLite state DB.
rm -rf ~/.local/state/pi-wallpaper-engine
```

## 3. Remove the project directory

```bash
rm -rf ~/path/to/pi-wallpaper-engine
```

## 4. Disable linger (if you don't run any other user services)

```bash
sudo loginctl disable-linger "$USER"
```

## 5. Remove SteamCMD session (optional — kills login for ALL SteamCMD use)

```bash
rm -rf ~/Steam
rm -rf ~/.steam
```

## 6. Remove SteamCMD and box86 wrapper (optional)

```bash
sudo rm -f /usr/local/bin/steamcmd
rm -rf ~/.local/share/steamcmd
```

## 7. Uninstall apt packages (optional — only if no other app uses them)

The installer uses Valve's SteamCMD tarball through box86, not Debian's
`steamcmd` package.

```bash
sudo apt-get remove --purge mpv ffmpeg rsync box86 libc6:armhf
sudo rm -f /etc/apt/sources.list.d/box86.list
sudo rm -f /usr/share/keyrings/box86-archive-keyring.gpg
sudo dpkg --remove-architecture armhf
sudo apt-get autoremove
```

## 8. Remove Bun (optional)

```bash
rm -rf ~/.bun
```
