import { useState } from "react"
import { signInPasskey } from "../auth.js"
import { dispatchAuthChange } from "../api.js"

export const Login = () => {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onSignIn = async () => {
    setBusy(true)
    setError(null)
    try {
      await signInPasskey()
      dispatchAuthChange()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <img src="/favicon.svg" alt="" className="auth-logo" width={56} height={56} />
        <h1 className="auth-title">Pi Wallpaper Engine</h1>
        <p className="auth-subtitle">Sign in with a registered passkey to continue.</p>
        <button className="auth-btn" type="button" onClick={onSignIn} disabled={busy}>
          {busy ? "Waiting for passkey…" : "Sign in with passkey"}
        </button>
        {error && <p className="auth-error">{error}</p>}
      </div>
    </div>
  )
}
