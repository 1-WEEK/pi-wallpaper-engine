// Interface sounds master switch (ticket 10 builds the switch only; ticket
// 13 wires the actual Web Audio engine). Default OFF, persisted in
// localStorage — spec §6. Fully separate from PlayerBar wallpaper audio.

const KEY = "pwe-interface-sounds"

export const INTERFACE_SOUNDS_CHANGED = "pwe-interface-sounds-changed"

export const getInterfaceSounds = (): boolean => {
  try {
    return localStorage.getItem(KEY) === "1"
  } catch {
    return false
  }
}

export const setInterfaceSounds = (on: boolean): void => {
  try {
    localStorage.setItem(KEY, on ? "1" : "0")
  } catch {
    // Private mode / storage denial: the switch still flips in memory.
  }
  window.dispatchEvent(new Event(INTERFACE_SOUNDS_CHANGED))
}
