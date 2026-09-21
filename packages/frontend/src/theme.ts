// Theme model for the redesign (spec §2.1): THEME[A] cream / THEME[B] black /
// AUTO follows `prefers-color-scheme` live; a manual choice overrides the
// system and is persisted. The resolved theme lands on <html data-theme> —
// the inline boot script in index.html makes the same write before first
// paint (keep its storage key and attribute in sync with this module).
import { useEffect, useState } from "react"

export type ThemeChoice = "light" | "dark" | "auto"
export type ResolvedTheme = "light" | "dark"

export const THEME_STORAGE_KEY = "pwe-theme"

export const normalizeThemeChoice = (raw: string | null): ThemeChoice =>
  raw === "light" || raw === "dark" ? raw : "auto"

export const resolveThemeChoice = (
  choice: ThemeChoice,
  system: ResolvedTheme
): ResolvedTheme => (choice === "auto" ? system : choice)

export const systemTheme = (): ResolvedTheme =>
  window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"

/** Writes the resolved theme onto <html> for the token layer in tokens.css. */
export const applyTheme = (theme: ResolvedTheme): void => {
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
}

export const useTheme = (): {
  choice: ThemeChoice
  resolved: ResolvedTheme
  setChoice: (choice: ThemeChoice) => void
} => {
  const [choice, setChoiceState] = useState<ThemeChoice>(() =>
    normalizeThemeChoice(localStorage.getItem(THEME_STORAGE_KEY))
  )
  const [system, setSystem] = useState<ResolvedTheme>(systemTheme)

  // AUTO follows the OS in real time; a manual choice simply ignores this.
  useEffect(() => {
    const mql = window.matchMedia("(prefers-color-scheme: light)")
    const onChange = () => setSystem(mql.matches ? "light" : "dark")
    mql.addEventListener("change", onChange)
    return () => mql.removeEventListener("change", onChange)
  }, [])

  const resolved = resolveThemeChoice(choice, system)
  useEffect(() => applyTheme(resolved), [resolved])

  const setChoice = (next: ThemeChoice) => {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next)
    } catch {
      // storage unavailable (private mode) — the session choice still applies
    }
    setChoiceState(next)
  }

  return { choice, resolved, setChoice }
}
