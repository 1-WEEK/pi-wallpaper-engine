import * as Dialog from "@radix-ui/react-dialog"
import { useEffect, useRef, useState } from "react"
import type { LibraryItem } from "@pwe/shared"
import { appIcons } from "../icons.js"
import { MobileSheet, useLayout } from "./mobile/index.js"

interface Props {
  item: LibraryItem
  onClose: () => void
}

// plyr's d.ts is `export =` but Vite serves the ESM build, where the
// constructor lives on `default` — hence the alias + cast at the import site.
type Plyr = InstanceType<typeof import("plyr")>

const HEVC_NOTICE =
  "This browser can't decode HEVC video. The file itself is fine — try Safari or a browser with hardware HEVC support."

const PreviewPlayer = ({ item }: { item: LibraryItem }) => {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    let player: Plyr | null = null
    let cancelled = false

    // Assigned here (not in JSX) because the cleanup strips the attribute
    // behind React's back — a re-run of this effect must restore it.
    video.src = `/api/library/${item.workshop_id}/stream`

    // Plyr is only needed inside this overlay — load it (and its CSS) lazily
    // so the main bundle doesn't carry a video player nobody opened.
    Promise.all([import("plyr"), import("plyr/dist/plyr.css")])
      .then(([mod]) => {
        if (cancelled || !videoRef.current) return
        const PlyrCtor = (mod as unknown as { default: typeof mod }).default ?? mod
        player = new PlyrCtor(videoRef.current, {
          controls: ["play", "progress", "current-time", "duration", "mute", "volume", "fullscreen"],
        })
      })
      .catch(() => setError("Failed to load the video player."))

    // No H.264 fallback by design: an <video> error here almost always means
    // the browser lacks HEVC decode, so say that instead of a generic failure.
    const onError = () => setError(HEVC_NOTICE)
    video.addEventListener("error", onError)

    return () => {
      cancelled = true
      video.removeEventListener("error", onError)
      player?.destroy()
      // Detach the source so the browser aborts any in-flight range request
      // as soon as the overlay closes.
      video.removeAttribute("src")
      video.load()
    }
  }, [item.workshop_id])

  // Plyr re-parents the <video> node into its own wrapper, so React must
  // never remove or swap that element (removeChild would crash). On error the
  // stage is hidden with CSS and the notice rendered as a sibling instead.
  return (
    <div className="video-preview-body">
      <div className="video-preview-stage" style={error ? { display: "none" } : undefined}>
        <video
          ref={videoRef}
          className="video-preview-player"
          poster={item.preview_url || undefined}
          controls
          playsInline
        />
      </div>
      {error && <div className="video-preview-error">{error}</div>}
      <div className="video-preview-meta mono">
        {item.transcoded_resolution ?? item.source_resolution} ·{" "}
        {item.transcoded_codec ?? item.source_codec}
      </div>
    </div>
  )
}

export const VideoPreview = ({ item, onClose }: Props) => {
  const { mobile } = useLayout()

  if (mobile) {
    return (
      <MobileSheet open onClose={onClose} title={item.title} height="auto">
        <PreviewPlayer item={item} />
      </MobileSheet>
    )
  }

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="directory-dialog-overlay" />
        <Dialog.Content className="video-preview-dialog" aria-describedby={undefined}>
          <div className="video-preview-header">
            <Dialog.Title className="video-preview-title" title={item.title}>
              {item.title}
            </Dialog.Title>
            <Dialog.Close className="directory-dialog-close" aria-label="Close preview">
              {appIcons.close}
            </Dialog.Close>
          </div>
          <PreviewPlayer item={item} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
