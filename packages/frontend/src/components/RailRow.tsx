/** One rail ledger row (spec §2.3): name left, dotted leader, ●/○
 *  (selection) or → (command) aligned to the rail's right edge. Styles live
 *  in library.css under the lib-rc-* block — the shared rail-control
 *  language (ticket 11 hover: instant 1-bit dither band + carved glyph
 *  chips; selection stays accent text, never an inversion block). */
export const RailRow = ({
  label,
  mark,
  on = false,
  onClick,
}: {
  label: string
  mark: string
  on?: boolean
  onClick: () => void
}) => (
  <button
    type="button"
    className={`lib-rc-row mono${on ? " is-on" : ""}`}
    // Only selection rows are toggles; → command rows carry no pressed state.
    {...(mark === "→" ? {} : { "aria-pressed": on })}
    onClick={onClick}
  >
    <span className="lib-rc-row-name">{label}</span>
    <span className="lib-rc-row-dots" aria-hidden="true" />
    <span className={mark === "→" ? "lib-rc-cmd-mark" : "lib-rc-row-mark"}>{mark}</span>
  </button>
)
