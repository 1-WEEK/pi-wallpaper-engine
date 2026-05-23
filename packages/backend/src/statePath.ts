import { homedir } from "node:os"
import { resolve } from "node:path"

export const STORAGE_HELPER_PATH = "/usr/local/lib/pwe-storage-helper"

// Mount base and sentinel are backend constants, not user config. The helper
// hardcodes the same mount base; the two must agree.
export const STORAGE_MOUNT_BASE = "/run/pwe/mounts"
export const STORAGE_MOUNT_SENTINEL = ".pwe-mounted-root"

// There is exactly one SMB connection; this fixed name is its keyring key and
// mount directory name.
export const SMB_CONNECTION_NAME = "smb"

export const resolveStateRoot = (): string => {
  const xdgStateHome = process.env["XDG_STATE_HOME"]
  return xdgStateHome
    ? resolve(xdgStateHome, "pi-wallpaper-engine")
    : resolve(homedir(), ".local/state/pi-wallpaper-engine")
}

export const resolveDbPath = (): string => resolve(resolveStateRoot(), "pi-wallpaper-engine.db")

export const storageSecretKey = (connectionName: string): string =>
  `pi-wallpaper-engine/storage/${connectionName}`
