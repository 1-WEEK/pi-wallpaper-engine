import { useState } from "react"
import { registerPasskey, setupAdmin } from "../auth.js"
import { dispatchAuthChange } from "../api.js"

type Step = "form" | "passkey" | "done"

export const Setup = () => {
  const [step, setStep] = useState<Step>("form")
  const [token, setToken] = useState("")
  const [email, setEmail] = useState("")
  const [name, setName] = useState("Admin")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
    setBusy(true)
    setError(null)
    try {
      await registerPasskey("Initial passkey")
      setStep("done")
      dispatchAuthChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <img src="/favicon.svg" alt="" className="auth-logo" width={56} height={56} />
        <h1 className="auth-title">First-time setup</h1>

        {step === "form" && (
          <>
            <p className="auth-subtitle">
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
              <button className="auth-btn" type="submit" disabled={busy}>
                {busy ? "Creating admin…" : "Create admin"}
              </button>
            </form>
          </>
        )}

        {step === "passkey" && (
          <>
            <p className="auth-subtitle">
              Admin account created. Register the first passkey to finish setup.
            </p>
            <button className="auth-btn" type="button" onClick={onRegisterPasskey} disabled={busy}>
              {busy ? "Waiting for passkey…" : "Register passkey"}
            </button>
            {error && (
              // Passkey registration failed. The backend created the admin
              // user but no passkey is bound — login is impossible until one
              // is. The backend's orphan-user cleanup makes restarting safe:
              // re-submitting the form will delete the half-baked user.
              <button
                className="auth-btn auth-btn-secondary"
                type="button"
                onClick={() => {
                  setStep("form")
                  setError(null)
                }}
              >
                Restart setup
              </button>
            )}
          </>
        )}

        {step === "done" && (
          <>
            <p className="auth-subtitle">Setup complete. Loading the app…</p>
          </>
        )}

        {error && <p className="auth-error">{error}</p>}
      </div>
    </div>
  )
}
