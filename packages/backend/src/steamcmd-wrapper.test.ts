import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"

const wrapperPath = resolve(import.meta.dir, "../../../scripts/steamcmd-wrapper.sh")
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const writeExecutable = async (path: string, contents: string) => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents)
  await chmod(path, 0o755)
}

const makeFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "pwe-steamcmd-wrapper-"))
  tempDirs.push(root)

  const home = join(root, "home")
  const steamcmdDir = join(home, ".local", "share", "steamcmd")
  const binDir = join(root, "bin")
  const box86Log = join(root, "box86-args.log")

  await writeExecutable(
    join(binDir, "box86"),
    `#!/usr/bin/env bash
printf '%s\\n' "$@" >> "${box86Log}"
exec "$@"
`,
  )
  await writeExecutable(
    join(steamcmdDir, "steamcmd.sh"),
    `#!/usr/bin/env bash
platform="\${STEAM_PLATFORM:-linuxarm64}"
steamcmd="$PWD/$platform/steamcmd"
if [ ! -e "$steamcmd" ]; then
  echo "Couldn't find steamcmd at $steamcmd, exiting" >&2
  exit 1
fi
if [ -n "\${DEBUGGER:-}" ]; then
  exec "$DEBUGGER" "$steamcmd" "$@"
fi
exec "$steamcmd" "$@"
`,
  )
  await writeExecutable(
    join(steamcmdDir, "linux32", "steamcmd"),
    `#!/usr/bin/env bash
printf '%s\\n' steamcmd-ok
`,
  )

  return { binDir, box86Log, home }
}

describe("steamcmd wrapper", () => {
  test("starts the x86 SteamCMD binary through box86 on ARM", async () => {
    const fixture = await makeFixture()
    const env = { ...process.env }
    delete env.DEBUGGER
    delete env.STEAM_PLATFORM
    const child = Bun.spawn(["bash", wrapperPath, "+quit"], {
      env: {
        ...env,
        HOME: fixture.home,
        PATH: `${fixture.binDir}:${env.PATH ?? ""}`,
      },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])

    expect(exitCode).toBe(0)
    expect(stdout).toContain("steamcmd-ok")
    expect(stderr).not.toContain("linuxarm64/steamcmd")
    expect(await readFile(fixture.box86Log, "utf8")).toContain("linux32/steamcmd")
  })
})
