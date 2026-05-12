export const Settings = () => {
  return (
    <div className="page">
      <h2>Settings</h2>
      <p className="hint">
        Config is loaded from <code>config.json</code> on the Pi. Edit that file directly to change
        Steam credentials, data root, screen geometry, or mpv options. Restart the backend
        (<code>systemctl --user restart pi-wallpaper-engine</code>) after editing.
      </p>
      <p className="hint">
        See <code>config.example.json</code> in the project root for the full set of options.
      </p>
    </div>
  )
}
