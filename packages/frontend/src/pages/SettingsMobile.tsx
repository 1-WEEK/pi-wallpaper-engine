// Settings mobile (implementation ticket 14) — spec §9 degradation: the
// desktop rail navigation becomes a section-list → detail two-layer flow.
// Layer one is four command rows (Playback / Storage / Access & Security /
// System) with mono live readings; a row opens the detail layer, which
// renders the exact section bodies shared with SettingsDesktop (spec §4.4
// content semantics are unchanged). Navigation is URL-addressable via
// ?sec= so the system back gesture returns to the list. The glass
// directory-change focused flow is shared with the desktop as-is.
import useSWR from "swr"
import { Link, useSearch } from "wouter"
import type { SystemSummary } from "@pwe/shared"
import { api } from "../api.js"
import { fetchSetupState } from "../auth.js"
import { StateBlock } from "../components/StateBlock.js"
import {
  AccessSec,
  buildHealthItems,
  gbFree,
  normalizeSec,
  PlaybackSec,
  StorageSec,
  SystemSec,
  type Sec,
} from "./SettingsDesktop.js"

interface Props {
  summary: SystemSummary | null
  onRefresh: () => void
}

const HEAD_TITLE: Record<Sec, string> = {
  playback: "Playback",
  storage: "Storage",
  access: "Access",
  system: "System",
}

export const SettingsMobile = ({ summary, onRefresh }: Props) => {
  const search = useSearch()
  const secParam = new URLSearchParams(search).get("sec")
  const sec = secParam === null ? null : normalizeSec(secParam)
  const { data: setupState } = useSWR("auth-setup-state", fetchSetupState)
  const { data: storage, mutate: mutateStorage } = useSWR("storage", api.getStorage, {
    refreshInterval: (data) => (data?.migration?.state === "running" ? 1000 : 5000),
    revalidateIfStale: true,
  })

  const health = summary ? buildHealthItems(summary) : []
  const warnCount = health.filter((h) => h.warn).length

  const reading = (s: Sec): string => {
    if (!summary) return "…"
    switch (s) {
      case "playback":
        return `MODE — ${(summary.status.player?.play_mode ?? "single").toUpperCase()}`
      case "storage": {
        const migration = storage?.migration
        if (migration?.state === "running") {
          const pct = Math.min(
            100,
            Math.round((migration.moved_bytes / Math.max(1, migration.total_bytes)) * 100)
          )
          return `MIGRATING ${pct}%`
        }
        return summary.status.storage.free_bytes !== null
          ? gbFree(summary.status.storage.free_bytes)
          : "—"
      }
      case "access":
        return setupState?.enabled ? "PASSKEY" : "LAN ONLY"
      case "system":
        return warnCount > 0
          ? `${health.length - warnCount} OK — ${warnCount} WARN`
          : `${health.length} OK`
    }
  }

  if (sec === null) {
    return (
      <div className="setm">
        <header className="setm-head pt-enter">
          <h1 className="setm-title">Settings</h1>
          <span className="setm-count mono">4 SECTIONS</span>
        </header>
        <nav className="setm-list" aria-label="Settings sections">
          {(Object.keys(HEAD_TITLE) as Sec[]).map((s, i) => (
            <Link
              key={s}
              href={`/settings?sec=${s}`}
              className="setm-row pt-enter"
              style={{ "--pt-i": i + 1 } as React.CSSProperties}
            >
              <span className="setm-row-name">{HEAD_TITLE[s]}</span>
              <span className="setm-row-dots" aria-hidden="true" />
              <span className="setm-row-val mono">{reading(s)}</span>
              <span className="setm-row-arrow" aria-hidden="true">
                →
              </span>
            </Link>
          ))}
        </nav>
      </div>
    )
  }

  return (
    <div className="setm">
      <header className="setm-head">
        <Link href="/settings" className="setm-back mono">
          ← SETTINGS
        </Link>
        <h1 className="setm-title setm-title-sub">{HEAD_TITLE[sec]}</h1>
      </header>

      {!summary ? (
        <StateBlock kind="loading" text="LOADING PI CONFIGURATION" />
      ) : (
        <div className="setm-body">
          {sec === "playback" && <PlaybackSec summary={summary} onRefresh={onRefresh} />}
          {sec === "storage" &&
            (storage ? (
              <StorageSec
                summary={summary}
                storage={storage}
                mutateStorage={(next) => void mutateStorage(next, { revalidate: false })}
                onRefresh={onRefresh}
              />
            ) : (
              <StateBlock kind="loading" text="READING STORAGE" />
            ))}
          {sec === "access" && <AccessSec />}
          {sec === "system" && <SystemSec summary={summary} />}
        </div>
      )}
    </div>
  )
}
