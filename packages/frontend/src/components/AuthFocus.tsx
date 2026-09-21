// AuthFocus — the passkey focused overlay (implementation ticket 14,
// spec §9): the only glass surface on the Login/Setup pages. Shown while
// the WebAuthn ceremony is pending; cancel abandons the wait — the caller
// guards with a ref so a late resolution can't sign in behind the user's
// back.
export const AuthFocus = ({
  title,
  reading,
  onCancel,
}: {
  title: string
  reading: string
  onCancel: () => void
}) => (
  <div className="auth-focus" role="dialog" aria-modal="true" aria-label={title}>
    <div className="auth-focus-scrim" />
    <div className="auth-focus-panel">
      <h2 className="auth-focus-title">{title}</h2>
      <p className="auth-focus-reading mono">{reading}</p>
      <button type="button" className="auth-focus-cancel" onClick={onCancel}>
        CANCEL
      </button>
    </div>
  </div>
)
