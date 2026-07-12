import { homedir } from "node:os"
import { resolve } from "node:path"

export const expandHome = (path: string): string =>
  path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : resolve(path)
