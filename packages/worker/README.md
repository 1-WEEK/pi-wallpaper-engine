# @pwe/worker

NAS-side transcoding worker. Pulls `TranscodeJob` entries from the Pi backend,
runs ffmpeg with hardware HEVC (Intel QSV) when available, falls back to
libx265 software encoding, and writes the result back over the shared media
path.

Deployment model: **the image is built on your dev machine and distributed**
to the NAS via a container registry (recommended) or a docker tarball. The
NAS only ever needs the `docker-compose.yml` file and an `.env` — no source
checkout, no `docker build`.

## Prerequisites (one-time)

1. The Pi `data_root` (or `storage.root` override) **must be the same
   physical share** the Worker mounts at `/data`. If the Pi is serving from
   its local SD card, the Worker has nothing to read.
2. Generate a worker key and put the SAME value on both sides:
   ```bash
   openssl rand -hex 32
   ```
   - Pi: append `PWE_WORKER_API_KEY=<value>` to
     `~/.config/pi-wallpaper-engine/auth.env`, then restart the backend.
   - NAS: put it in the `.env` file next to `docker-compose.yml` (below).
3. Intel iGPU at `/dev/dri/renderD128` for hardware encoding (optional —
   the Worker degrades to libx265 software encoding without it).

## Workflow

### A. Build + push to a registry (recommended)

From the monorepo root on your **dev machine**:

```bash
# One-time: log in to your registry. ghcr.io uses a GitHub PAT with
# `write:packages` scope.
echo $GITHUB_TOKEN | docker login ghcr.io -u <github-user> --password-stdin

# Build for linux/amd64 (Intel NAS) and push:
PWE_WORKER_REGISTRY=ghcr.io/<github-user>/pwe-worker \
PWE_WORKER_TAG=0.1.0 \
packages/worker/scripts/release.sh --push
```

The script tags both `:0.1.0` and `:latest`. Multi-arch (`linux/amd64` +
`linux/arm64`) can be enabled with `--multi`.

On the **NAS**:

```bash
# Pull the docker-compose.yml + .env.example from this repo (or scp them
# from the dev box). Edit .env to point at your image and Pi.
cp .env.example .env
$EDITOR .env

docker login ghcr.io                 # only if your image is private
docker compose pull
docker compose up -d
```

### B. Tarball workflow (no registry)

From the monorepo root on your dev machine:

```bash
# Build locally (loads into your dev docker daemon):
PWE_WORKER_TAG=0.1.0 packages/worker/scripts/release.sh

# Pack and ship:
docker save ghcr.io/<user>/pwe-worker:0.1.0 | gzip > pwe-worker-0.1.0.tar.gz
scp pwe-worker-0.1.0.tar.gz nas:/tmp/
```

On the NAS:

```bash
docker load < /tmp/pwe-worker-0.1.0.tar.gz
docker compose up -d
```

The image tag inside the tarball matches what `release.sh` printed; that's
the value you put in `PWE_WORKER_IMAGE` in your `.env`.

## Files the NAS actually needs

Only two:

- `docker-compose.yml` (this directory)
- `.env` (copy from `.env.example` and fill in)

That's it. The image, the source, the lockfile — none of it touches the NAS.

## .env reference

| Variable | Required | Notes |
|---|---|---|
| `PWE_WORKER_IMAGE` | ✓ | Full image ref including tag. e.g. `ghcr.io/you/pwe-worker:0.1.0`. |
| `PWE_WORKER_API_KEY` | ✓ | Shared secret, ≥8 chars. Must match the Pi side. |
| `PWE_BACKEND_URL` | ✓ | LAN URL of the Pi (avoid public Tunnel URLs). |
| `PWE_WORKER_NAME` | – | Identifier reported during claim (default `nas-01`). |
| `PWE_MEDIA_HOST` | ✓ | Host path of the shared media. Mounted into the container at `/data`. |

## Operations

- One job at a time. No Worker-side concurrency by design — keeps NAS load
  predictable and avoids the need for resource limiters.
- Heartbeats every 15s. Stale claims (no heartbeat within
  `heartbeat_timeout_ms`, default 60s) are reset to `pending` by the Pi's
  `TranscodeMonitor` and re-claimed.
- The Worker writes `<id>.mp4.partial` then renames on success. Crashes
  leave the `.partial`; the next claim deletes it before re-running
  ffmpeg, so jobs are idempotent.
- Progress reports are throttled to every 5% to keep DB write load minimal.

## Verifying QSV

After `docker compose up -d`, watch the first ten seconds of logs:

```bash
docker logs pwe-worker | head -20
```

Healthy QSV startup looks like:

```
▶ pwe-worker "nas-01" → http://pi.local:8080
  media root: /data
  encoder: qsv — hevc_qsv device probe succeeded
```

If you see `encoder: x265 — hevc_qsv device probe failed (...)`, the QSV
path is not wired through Docker. Confirm `/dev/dri` exists on the host
and `docker-compose.yml` still has the `devices: - /dev/dri:/dev/dri`
mapping. (The Worker still works — libx265 fallback — just slower.)

## Rollback

```bash
docker compose down
```

The job queue in the Pi DB stays as-is; `TranscodeMonitor` will reset any
claimed/running rows back to `pending` within ~30s.
