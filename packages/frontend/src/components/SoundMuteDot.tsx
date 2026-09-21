// SoundMuteDot — the shell's persistent quick-mute for interface sounds
// (ticket 13, spec §6/§5 控制入口): a small round dot at the shell's
// bottom-right, floating above the PlayerBar dock's right end. Position,
// shape and semantics are deliberately separate from the PlayerBar — the
// dock owns wallpaper audio (mpv on the Pi), this dot owns interface
// sounds only. Renders only while the Settings master switch is ON (with
// it OFF there is nothing to mute); toggling is instant — in-flight
// voices are cancelled, not faded.
import { useSyncExternalStore } from "react"
import { appIcons } from "../icons.js"
import { sounds } from "../sound.js"

export const SoundMuteDot = () => {
  const state = useSyncExternalStore(sounds.subscribe, () =>
    sounds.enabled ? (sounds.isMuted ? "muted" : "on") : "off"
  )
  if (state === "off") return null
  const muted = state === "muted"
  return (
    <button
      type="button"
      className={`sound-dot${muted ? " is-muted" : ""}`}
      aria-label={muted ? "Unmute interface sounds" : "Mute interface sounds"}
      aria-pressed={muted}
      title="Interface sounds — wallpaper audio is unaffected"
      onClick={() => sounds.toggleMuted()}
    >
      {muted ? appIcons.soundOff : appIcons.soundOn}
    </button>
  )
}
