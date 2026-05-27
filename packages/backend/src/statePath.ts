import { homedir } from "node:os"
import { resolve } from "node:path"

export const resolveStateRoot = (): string => {
  const xdgStateHome = process.env["XDG_STATE_HOME"]
  return xdgStateHome
    ? resolve(xdgStateHome, "pi-wallpaper-engine")
    : resolve(homedir(), ".local/state/pi-wallpaper-engine")
}

export const resolveDbPath = (): string => resolve(resolveStateRoot(), "pi-wallpaper-engine.db")
