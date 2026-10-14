import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { loadConfig } from "./Config.js"

const loadBudgets = async (budget: Record<string, unknown>) => {
  const dir = await mkdtemp(join(tmpdir(), "pwe-cache-config-"))
  try {
    const template = await Bun.file(join(import.meta.dir, "../../../../config.example.json")).json()
    await writeFile(join(dir, "config.json"), JSON.stringify({
      ...template,
      steam: { ...template.steam, username: "test", web_api_key: "test" },
      paths: { ...template.paths, data_root: dir },
      mpv: { ...template.mpv, ...budget },
    }))
    return await Effect.runPromise(loadConfig(join(dir, "config.json")).pipe(Effect.result))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test("configuration loading rejects negative cache budgets with the failing field", async () => {
  for (const field of ["cache_forward_mib", "cache_backward_mib"]) {
    const result = await loadBudgets({ [field]: -1 })
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.failure._tag).toBe("ConfigError")
      expect(result.failure.reason).toContain("Schema validation failed")
      expect(result.failure.reason).toContain(field)
    }
  }
})

test("configuration loading rejects fractional cache budgets", async () => {
  for (const field of ["cache_forward_mib", "cache_backward_mib"]) {
    const result = await loadBudgets({ [field]: 1.5 })
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure.reason).toContain(field)
  }
})

test("configuration loading rejects cache budgets whose byte conversion is unsafe", async () => {
  for (const field of ["cache_forward_mib", "cache_backward_mib"]) {
    const result = await loadBudgets({ [field]: 8589934592 })
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure.reason).toContain(field)
  }
})
