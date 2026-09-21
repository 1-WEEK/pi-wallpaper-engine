// Login (implementation ticket 14) — spec §9 light treatment: a pure
// typographic skeleton page (Clash title + mono ledger readings on the
// token layer). The passkey ceremony gets the page's only glass surface —
// the AuthFocus overlay — while it is pending.
import { useRef, useState } from "react"
import { signInPasskey } from "../auth.js"
import { dispatchAuthChange } from "../api.js"
import { AuthFocus } from "../components/AuthFocus.js"

export const Login = () => {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Cancel guard: abandoning the wait must not let a late ceremony
  // resolution dispatch the auth change behind the user's back.
  const cancelled = useRef(false)

  const onSignIn = async () => {
    cancelled.current = false
    setBusy(true)
    setError(null)
    try {
      await signInPasskey()
      if (!cancelled.current) dispatchAuthChange()
    } catch (e) {
      if (!cancelled.current) setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-page pt-enter">
        <div className="auth-brand mono">PI WALLPAPER ENGINE</div>
        <h1 className="auth-title">Sign in</h1>
        <div className="auth-row">
          <span>Access</span>
          <span className="auth-row-dots" aria-hidden="true" />
          <span className="auth-row-val mono">PASSKEY</span>
        </div>
        <p className="auth-sub">Sign in with a registered passkey to continue.</p>
        <button className="auth-cmd" type="button" onClick={onSignIn} disabled={busy}>
          {busy ? "WAITING FOR PASSKEY…" : "SIGN IN WITH PASSKEY →"}
        </button>
        {error && <p className="auth-error mono">ERR — {error}</p>}
      </div>
      {busy && (
        <AuthFocus
          title="Passkey"
          reading="WAITING FOR PASSKEY — COMPLETE THE SYSTEM PROMPT"
          onCancel={() => {
            cancelled.current = true
            setBusy(false)
          }}
        />
      )}
    </div>
  )
}
