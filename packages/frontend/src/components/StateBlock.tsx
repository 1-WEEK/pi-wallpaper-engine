// StateBlock — the shared three-state block (spec §3.3): skeleton (pulsing
// cross + scanline) / empty / error, plus the static "end of list" variant.
// All kinds share the pt-enter mount choreography. Page-level error is only
// for a full-page load failure; routine errors sit next to the nearest
// place that can handle them (the infinite-scroll sentinel).
export const StateBlock = ({
  kind,
  text,
  onRetry,
}: {
  kind: "loading" | "empty" | "error" | "end"
  text: string
  onRetry?: () => void
}) => (
  <div
    className={`bws-state bws-state-${kind} pt-enter`}
    role={kind === "error" ? "alert" : "status"}
  >
    <span className="bws-state-cross mono" aria-hidden="true">
      +
    </span>
    <span className="bws-state-text mono">{text}</span>
    {onRetry && (
      <button type="button" className="bws-state-retry mono" onClick={onRetry}>
        RETRY
      </button>
    )}
    <span className="bws-state-scan" aria-hidden="true" />
  </div>
)
