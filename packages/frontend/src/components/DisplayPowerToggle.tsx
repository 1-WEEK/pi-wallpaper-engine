import { appIcons } from "../icons.js"

interface Props {
  state: "on" | "off" | "unknown"
  configured: boolean
  pending: boolean
  onToggle: () => void
  compact?: boolean
}

export const DisplayPowerToggle = ({
  state,
  configured,
  pending,
  onToggle,
  compact = false,
}: Props) => {
  const isOn = state === "on"
  const disabled = !configured || pending
  const label = !configured ? "n/a" : state === "unknown" ? "—" : state
  const title = configured
    ? `Display is ${state}. Click to turn ${isOn ? "off" : "on"}.`
    : "Configure display.on_command / off_command to enable"
  const tone = !configured ? "off" : state === "on" ? "on" : state === "off" ? "off" : "unknown"

  return (
    <button
      type="button"
      onClick={disabled ? undefined : onToggle}
      aria-pressed={isOn}
      aria-label={
        configured
          ? `Turn display ${isOn ? "off" : "on"}`
          : "Display power not configured"
      }
      title={title}
      disabled={disabled}
      className={`display-toggle display-toggle-${tone} ${compact ? "display-toggle-compact" : ""}`}
    >
      <span className="display-toggle-icon">{appIcons.display}</span>
      {!compact && (
        <span className="display-toggle-label mono">
          <span className="display-toggle-dot" aria-hidden="true" />
          {label}
        </span>
      )}
    </button>
  )
}
