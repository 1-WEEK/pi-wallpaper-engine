// Interface sound layer (ticket 13, spec §6; sound spec:
// .scratch/ui-redesign/research/15-sound-spec.md).
//
// Direction B — BLOOM, warm tonal: sine/triangle bodies, 8–12ms soft
// attacks, short pitch droops. Four semantic families
// (nav / commit / transition / warn); variants within a family derive only
// from pitch and gain — no component invents an out-of-family sound.
//
// Native Web Audio, zero dependencies:
//   - lazy AudioContext: created/resumed only from a real user gesture and
//     only while the master switch is ON. The switch (default OFF,
//     localStorage) lives in interfaceSounds.ts (ticket 10); this module is
//     the engine behind it.
//   - background tabs stay silent: triggers while document.hidden drop,
//     hiding the page cancels in-flight voices, nothing replays on return.
//   - every failure path (no Web Audio, blocked autoplay, refused resume)
//     is a silent no-op — sound is a pure enhancement layer; with it off,
//     no information or interaction is lost.
//   - reduced motion skips the transition family only (it is coupled to
//     arrival/settle animation); nav/commit/warn carry information and stay.
//
// Fully separate from PlayerBar wallpaper audio (mpv on the Pi): no shared
// volume or mute state, and no backend/mpv API exists for interface sounds.

import { getInterfaceSounds, INTERFACE_SOUNDS_CHANGED } from "./interfaceSounds.js"
import { prefersReducedMotion } from "./reducedMotion.js"

/* ── Direction B family patches (sound spec §2/§4 — the ticket-15 lab's
     declarative BLOOM direction, inlined). Envelope: linear soft attack to
     peak, then exponential decay; voice life ≈ delay + attack + decay. ── */

export type SoundFamily = "nav" | "commit" | "transition" | "warn"

interface LayerSpec {
  type: OscillatorType
  freq: number
  /** exponential glide target, optional */
  freqEnd?: number
  attack: number
  decay: number
  /** 0..1 relative to the master gain */
  gain: number
  /** seconds after the trigger before this layer starts */
  delay?: number
  filter?: { freq: number; freqEnd?: number; q?: number }
}

interface FamilySpec {
  /** nominal audible length, used for voice-slot bookkeeping (seconds) */
  duration: number
  layers: LayerSpec[]
}

export const SOUND_FAMILIES: Record<SoundFamily, FamilySpec> = {
  nav: {
    duration: 0.11,
    layers: [{ type: "sine", freq: 240, freqEnd: 180, attack: 0.008, decay: 0.075, gain: 0.32 }],
  },
  commit: {
    duration: 0.42,
    layers: [
      { type: "sine", freq: 220, attack: 0.01, decay: 0.2, gain: 0.34 },
      { type: "sine", freq: 330, attack: 0.01, decay: 0.24, gain: 0.28, delay: 0.06 },
      { type: "triangle", freq: 110, attack: 0.012, decay: 0.3, gain: 0.16 },
    ],
  },
  transition: {
    duration: 0.34,
    layers: [
      {
        type: "sawtooth",
        freq: 160,
        attack: 0.05,
        decay: 0.18,
        gain: 0.14,
        filter: { freq: 500, freqEnd: 2400, q: 2 },
      },
      { type: "sine", freq: 160, freqEnd: 240, attack: 0.04, decay: 0.2, gain: 0.2 },
    ],
  },
  warn: {
    duration: 0.4,
    layers: [
      // minor-second beating reads as "wrong" without getting harsh
      { type: "triangle", freq: 150, attack: 0.01, decay: 0.26, gain: 0.3 },
      { type: "triangle", freq: 159, attack: 0.01, decay: 0.26, gain: 0.3 },
      { type: "sine", freq: 75, attack: 0.01, decay: 0.3, gain: 0.2 },
    ],
  },
}

/* ── Trigger matrix (sound spec §3). One id per product trigger; cooldown
     and reentry key on the id, not the family (commit-transport and
     commit-download share a family but have their own rows). The explicit
     SILENT rows — card/filter hover, scrolling, polling progress, keyboard
     repeats — are a decision, not a gap: they simply never call trigger(). ── */

export type SoundTrigger =
  | "nav" // page navigation / ledger row select — active-state first frame
  | "select" // wallpaper select (PLAY) — ×1.5 pitch
  | "dismiss" // cancel / close overlay — ×0.7 pitch, ×0.8 gain
  | "transport" // PlayerBar play/pause/next — icon-swap frame
  | "download" // download accepted (request taken, not complete) — ghost takeoff
  | "done" // download/migration complete — state receipt, settle beat
  | "display" // display on/off — ×0.7 gain, status-dot flip frame
  | "fail" // download/migration failed — state receipt, error-line expand
  | "armed" // destructive confirm armed — ×0.85 pitch, ×0.55 gain

interface TriggerSpec {
  family: SoundFamily
  pitch?: number
  gain?: number
  reentry: "overlap" | "restart" | "block"
  cooldownMs: number
}

export const SOUND_TRIGGERS: Record<SoundTrigger, TriggerSpec> = {
  nav: { family: "nav", reentry: "overlap", cooldownMs: 50 },
  select: { family: "nav", pitch: 1.5, reentry: "overlap", cooldownMs: 50 },
  dismiss: { family: "nav", pitch: 0.7, gain: 0.8, reentry: "overlap", cooldownMs: 60 },
  transport: { family: "commit", reentry: "restart", cooldownMs: 80 },
  download: { family: "commit", reentry: "restart", cooldownMs: 100 },
  done: { family: "transition", reentry: "block", cooldownMs: 500 },
  display: { family: "transition", gain: 0.7, reentry: "restart", cooldownMs: 200 },
  fail: { family: "warn", reentry: "block", cooldownMs: 800 },
  armed: { family: "warn", pitch: 0.85, gain: 0.55, reentry: "restart", cooldownMs: 300 },
}

const MAX_VOICES = 6
/** Default (and only) volume; master gain = volume × 0.9 (sound spec §4). */
const VOLUME = 0.9
const MUTED_KEY = "pwe-interface-sounds-muted"

const readMuted = (): boolean => {
  try {
    return localStorage.getItem(MUTED_KEY) === "1"
  } catch {
    return false
  }
}

interface ActiveVoice {
  id: SoundTrigger
  stop: () => void
  until: number
}

class SoundEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private active: ActiveVoice[] = []
  private lastFired: Partial<Record<SoundTrigger, number>> = {}
  private listeners = new Set<() => void>()
  private muted = readMuted()

  readonly supported =
    typeof window !== "undefined" && typeof window.AudioContext === "function"

  constructor() {
    if (typeof document === "undefined") return
    // Hiding the page cancels in-flight voices; nothing queues for a replay
    // when the tab comes back.
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.cancelAll()
    })
    // Autoplay unlock: the context is created/resumed only from real user
    // gestures, and only while the master switch is on. pointerdown runs
    // ahead of the click handlers that fire sounds, so the first triggering
    // gesture already plays.
    const unlock = () => this.unlock()
    window.addEventListener("pointerdown", unlock, { passive: true })
    window.addEventListener("keydown", unlock)
    window.addEventListener(INTERFACE_SOUNDS_CHANGED, () => this.syncEnabled())
  }

  /* ── state ── */

  get enabled(): boolean {
    return getInterfaceSounds()
  }

  get isMuted(): boolean {
    return this.muted
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  private emit() {
    for (const fn of this.listeners) fn()
  }

  /** Quick mute (shell dot) — instant: in-flight voices are cancelled and
   *  the master gain drops; wallpaper audio is untouched. Persisted. */
  setMuted(v: boolean) {
    if (this.muted === v) return
    this.muted = v
    try {
      localStorage.setItem(MUTED_KEY, v ? "1" : "0")
    } catch {
      // storage denied — session-only then
    }
    if (v) this.cancelAll()
    this.applyMasterGain()
    this.emit()
  }

  toggleMuted() {
    this.setMuted(!this.muted)
  }

  private syncEnabled() {
    if (!this.enabled) this.cancelAll()
    this.applyMasterGain()
    this.emit()
  }

  /* ── lifecycle ── */

  private unlock() {
    if (!this.supported || !this.enabled || this.muted) return
    try {
      this.ensureGraph()
      if (this.ctx && this.ctx.state === "suspended")
        void this.ctx.resume().then(
          () => this.emit(),
          () => {}
        )
    } catch {
      // blocked autoplay / missing Web Audio — silent no-op
    }
  }

  private ensureGraph() {
    if (this.ctx) return
    const ctx = new AudioContext()
    const master = ctx.createGain()
    // Shared compressor is the last line of defense against rapid-fire
    // stacking (sound spec §4).
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -18
    comp.knee.value = 12
    comp.ratio.value = 8
    comp.attack.value = 0.002
    comp.release.value = 0.12
    master.connect(comp)
    comp.connect(ctx.destination)
    this.ctx = ctx
    this.master = master
    this.applyMasterGain()
  }

  private applyMasterGain() {
    if (!this.master || !this.ctx) return
    const target = this.enabled && !this.muted ? VOLUME * 0.9 : 0
    this.master.gain.setTargetAtTime(target, this.ctx.currentTime, 0.015)
  }

  private cancelAll() {
    for (const v of this.active) v.stop()
    this.active = []
  }

  /* ── playback ── */

  trigger(id: SoundTrigger) {
    if (!this.supported || !this.enabled || this.muted) return
    if (document.hidden) return
    const spec = SOUND_TRIGGERS[id]
    // Reduced motion: the transition family is coupled to arrival/settle
    // animation — the motion is gone, so the sound must not stay (spec §6).
    if (spec.family === "transition" && prefersReducedMotion()) return

    const now = performance.now()
    if (now - (this.lastFired[id] ?? -Infinity) < spec.cooldownMs) return

    this.active = this.active.filter((v) => v.until > now)
    const same = this.active.filter((v) => v.id === id)
    if (spec.reentry === "block" && same.length > 0) return
    if (spec.reentry === "restart") {
      for (const v of same) v.stop()
      this.active = this.active.filter((v) => v.id !== id)
    }
    if (this.active.length >= MAX_VOICES) {
      console.debug(`[sound] voice cap ${MAX_VOICES} reached — dropped "${id}"`)
      return
    }

    try {
      this.ensureGraph()
      const ctx = this.ctx!
      // Trigger sites are component semantic handlers, not raw DOM event
      // bindings (spec §4): keyboard and pointer land here alike. If this
      // fire was not gesture-chained (state receipts: done/fail) and the
      // context is still suspended, the voice renders silently — the
      // intended degradation.
      if (ctx.state === "suspended") void ctx.resume().catch(() => {})

      const pitch = spec.pitch ?? 1
      const gainMul = spec.gain ?? 1
      const stops: Array<() => void> = []
      const family = SOUND_FAMILIES[spec.family]

      for (const layer of family.layers) {
        const t0 = ctx.currentTime + (layer.delay ?? 0)
        const g = ctx.createGain()
        const peak = Math.max(0.0001, layer.gain * gainMul)
        g.gain.setValueAtTime(0, t0)
        g.gain.linearRampToValueAtTime(peak, t0 + Math.max(layer.attack, 0.002))
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + layer.attack + layer.decay)

        const osc = ctx.createOscillator()
        osc.type = layer.type
        osc.frequency.setValueAtTime(layer.freq * pitch, t0)
        if (layer.freqEnd)
          osc.frequency.exponentialRampToValueAtTime(
            Math.max(1, layer.freqEnd * pitch),
            t0 + layer.attack + layer.decay
          )

        let node: AudioNode = osc
        if (layer.filter) {
          const f = ctx.createBiquadFilter()
          f.type = "lowpass"
          f.frequency.setValueAtTime(layer.filter.freq * pitch, t0)
          if (layer.filter.freqEnd)
            f.frequency.exponentialRampToValueAtTime(
              Math.max(10, layer.filter.freqEnd * pitch),
              t0 + layer.attack + layer.decay
            )
          if (layer.filter.q) f.Q.value = layer.filter.q
          osc.connect(f)
          node = f
        }
        node.connect(g)
        g.connect(this.master!)

        const life = (layer.delay ?? 0) + layer.attack + layer.decay + 0.08
        osc.start(t0)
        osc.stop(t0 + life)
        stops.push(() => {
          try {
            g.gain.cancelScheduledValues(ctx.currentTime)
            g.gain.setTargetAtTime(0, ctx.currentTime, 0.008)
            osc.stop(ctx.currentTime + 0.05)
          } catch {
            // already stopped
          }
        })
      }

      const voice: ActiveVoice = {
        id,
        stop: () => stops.forEach((s) => s()),
        until: now + family.duration * 1000,
      }
      this.active.push(voice)
      this.lastFired[id] = now
      // Prune the voice slot once the sound has decayed.
      window.setTimeout(() => {
        this.active = this.active.filter((v) => v !== voice)
      }, family.duration * 1000 + 120)
    } catch {
      // any engine failure is a silent no-op
    }
  }
}

export const sounds = new SoundEngine()
