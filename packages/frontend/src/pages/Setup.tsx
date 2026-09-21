// Setup (implementation ticket 14) — spec §9 light treatment, same
// skeleton as Login: Clash title + mono ledger readings; glass only for
// the passkey focused overlay (AuthFocus) during registration. The
// step flow and backend calls are unchanged from the legacy page.
import { useRef, useState } from "react"
import { registerPasskey, setupAdmin } from "../auth.js"
import { dispatchAuthChange } from "../api.js"
import { AuthFocus } from "../components/AuthFocus.js"

type Step = "form" | "passkey" | "done"

const STEP_READING: Record<Step, string> = {
  form: "STEP 1/2 — CREATE ADMIN",
  passkey: "STEP 2/2 — REGISTER PASSKEY",
  done: "SETUP COMPLETE",
}

export const Setup = () => {
  const [step, setStep] = useState<Step>("form")
  const [token, setToken] = useState("")
  const [email, setEmail] = useState("")
  const [name, setName] = useState("Admin")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Cancel guard: abandoning the passkey wait must not let a late ceremony
  // resolution dispatch the auth change behind the user's back.
  const cancelled = useRef(false)

  const onCreateAdmin = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await setupAdmin({ token: token.trim(), email: email.trim(), name: name.trim() || "Admin" })
      setStep("passkey")
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const onRegisterPasskey = async () => {
    cancelled.current = false
    setBusy(true)
    setError(null)
    try {
      await registerPasskey("Initial passkey")
      if (cancelled.current) return
      setStep("done")
      dispatchAuthChange()
    } catch (err) {
      if (!cancelled.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-page pt-enter">
        <div className="auth-brand mono">PI WALLPAPER ENGINE</div>
        <h1 className="auth-title">Setup</h1>
        <div className="auth-row">
          <span>Progress</span>
          <span className="auth-row-dots" aria-hidden="true" />
          <span className="auth-row-val mono">{STEP_READING[step]}</span>
        </div>

        {step === "form" && (
          <>
            <p className="auth-sub">
              Paste the one-time setup token from <code>$PWE_AUTH_SETUP_TOKEN</code>, then register
              your first passkey. The token is consumed on success.
            </p>
            <form className="auth-form" onSubmit={onCreateAdmin}>
              <label className="auth-field">
                <span>Setup token</span>
                <input
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  required
                  minLength={8}
                />
              </label>
              <label className="auth-field">
                <span>Admin email</span>
                <input
                  type="email"
                  autoComplete="off"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </label>
              <label className="auth-field">
                <span>Display name</span>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <button className="auth-cmd" type="submit" disabled={busy}>
                {busy ? "CREATING ADMIN…" : "CREATE ADMIN →"}
              </button>
            </form>
          </>
        )}

        {step === "passkey" && (
          <>
            <p className="auth-sub">
              Admin account created. Register the first passkey to finish setup.
            </p>
            <button className="auth-cmd" type="button" onClick={onRegisterPasskey} disabled={busy}>
              {busy ? "WAITING FOR PASSKEY…" : "REGISTER PASSKEY →"}
            </button>
            {error && (
              // Passkey registration failed. The backend created the admin
              // user but no passkey is bound — login is impossible until one
              // is. The backend's orphan-user cleanup makes restarting safe:
              // re-submitting the form will delete the half-baked user.
              <button
                className="auth-cmd auth-cmd-secondary"
                type="button"
                onClick={() => {
                  setStep("form")
                  setError(null)
                }}
              >
                RESTART SETUP
              </button>
            )}
          </>
        )}

        {step === "done" && <p className="auth-sub">Setup complete. Loading the app…</p>}

        {error && <p className="auth-error mono">ERR — {error}</p>}
      </div>
      {busy && step === "passkey" && (
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
