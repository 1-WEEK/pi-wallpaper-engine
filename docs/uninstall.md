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
# Edit path to match config.paths.data_root if you customized it
rm -rf ~/pi-wallpaper-engine-data
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
rm -rf ~/.steam
```

## 6. Uninstall apt packages (optional — only if no other app uses them)

```bash
sudo apt-get remove --purge mpv steamcmd ffmpeg
sudo apt-get autoremove
```

## 7. Remove Bun (optional)

```bash
rm -rf ~/.bun
```
