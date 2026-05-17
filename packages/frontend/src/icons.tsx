import type { ReactNode } from "react"

const AppIcon = ({
  children,
  size = 18,
}: {
  children: ReactNode
  size?: number
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
)

export const appIcons = {
  browse: (
    <AppIcon>
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20 L16 16" />
    </AppIcon>
  ),
  library: (
    <AppIcon>
      <path d="M4 7h16M4 12h16M4 17h10" />
    </AppIcon>
  ),
  downloads: (
    <AppIcon>
      <path d="M12 4 L12 15M6 11 L12 17 L18 11M5 20 L19 20" />
    </AppIcon>
  ),
  settings: (
    <AppIcon>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3 V6 M12 18 V21 M3 12 H6 M18 12 H21 M5.6 5.6 L7.7 7.7 M16.3 16.3 L18.4 18.4 M5.6 18.4 L7.7 16.3 M16.3 7.7 L18.4 5.6" />
    </AppIcon>
  ),
  play: (
    <AppIcon>
      <path d="M7 5 L19 12 L7 19 Z" />
    </AppIcon>
  ),
  pause: (
    <AppIcon>
      <path d="M7 5 L10 5 L10 19 L7 19 Z M14 5 L17 5 L17 19 L14 19 Z" />
    </AppIcon>
  ),
  stop: (
    <AppIcon>
      <rect x="6" y="6" width="12" height="12" rx="1" />
    </AppIcon>
  ),
  pi: (
    <AppIcon>
      <rect x="4" y="6" width="16" height="12" rx="2" />
      <path d="M8 6 V3 M16 6 V3 M8 21 V18 M16 21 V18" />
    </AppIcon>
  ),
}
