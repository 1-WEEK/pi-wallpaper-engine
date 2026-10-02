# Pi Wallpaper Engine Context

A video wallpaper player for a single Raspberry Pi administrator. The administrator
browses Steam Workshop, downloads video wallpapers, chooses where media lives, and
controls playback and display power.

## Language

### Downloads

**Download intake**: The lifecycle of accepting one Steam Workshop item and
carrying it until it becomes a library wallpaper or fails with visible cleanup.

**Download cancellation**: A request to stop an intake, including its ongoing
work, and leave a visible terminal cleanup state.

**Download process registry**: The local record connecting an intake to the
SteamCMD process doing its work.

**Download progress stream**: Live per-item observations of where an intake is
in its lifecycle.

**Download reconciler**: The maintenance that turns interrupted or stale intakes
into visible terminal results and removes unsafe leftovers.

### Storage

**Media root**: The currently active directory for media reads and writes. It is
the custom root when one is selected, otherwise the default root.

**Default root**: The configured baseline media directory used when the
administrator has not selected a custom root.

**Custom root**: The administrator's persisted override of the default root.
Clearing it returns media storage to the default root.

**Allowed roots**: The directories within which the administrator may browse and
select a media root.

**Target root**: A directory being considered for selection, pending validation
and any required migration.

**Switch plan**: The decision for a validated target: keep the current root,
select the target immediately, or migrate existing media before switching.

### Access

**Administrator access**: The authority to control Pi Wallpaper Engine through
its web interface. It belongs to the single device administrator.

**Steam connection**: The external Steam identity and credential state used to
discover and download Workshop items. It does not grant administrator access.

### Playback

**Playback orchestration**: Coordination of wallpaper playback, stepping,
rotation, the play limit, and display power so that their effects stay
consistent.

**Play limit**: The administrator's setting to stop playback after a number of
minutes, edited from the PlayerBar or from Settings. It has two modes:
**permanent**, which re-arms on every playback session and survives restarts,
and **one-shot**, which applies to a single session and is consumed when that
session ends. Off means no limit.

**Playback session**: The span from one play to the next stop. A play limit
counts down across the whole span, so pausing or stepping to another wallpaper
does not restart it — only stopping and playing again does.

### Transcoding

**Transcode mode**: Whether remote transcoding is enabled. Direct-playback mode
skips new transcode requests; worker mode can queue them for a remote worker.

**Transcode decision**: The per-wallpaper judgment of whether the source needs
conversion for the Pi's screen and playback capabilities, and the target
resolution and codec when it does.

**Transcode queue**: The service that accepts transcode decisions, offers jobs
to workers, and exposes their progress alongside the library wallpaper.

**Transcode job**: One request to convert a wallpaper. It progresses through
waiting, claim, encoding, and upload before completing or failing.

**Transcode monitor**: Maintenance that detects stale worker claims and makes
their jobs available for retry.
