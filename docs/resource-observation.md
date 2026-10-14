# Passive Pi resource observation

`scripts/observation/observe.py` uses Python 3.8+ standard libraries. It reads
Linux counters and requests mpv properties; it does not change playback, display,
downloads, service state or connectivity. Run it as the service's user, through
SSH/SFTP. No remote agent or package installation is needed.

A prepared collector is not a completed baseline. Ticket 01 needs an actual
original 24-hour window, and ticket 07 needs a separate candidate window after
reviewed hardware verification. Neither ticket can close with synthetic tests.

## Start a window

First confirm the reachable SSH address, deployed service working directory,
config path, and local database path. Record the local integration revision
separately from the deployed revision. The config's `display.status_command`
may be enabled with `--probe-display` only after inspecting that it is a
non-interactive, read-only probe. Without that option the report labels display
state unknown; display-off coverage remains missing.

Upload only the collector, keeping it outside the deployed repository:

```sh
sftp YOUR_PI
mkdir .local/share/pwe-observation
put scripts/observation/observe.py .local/share/pwe-observation/observe.py
exit
```

On the Pi, via SSH, use a unique output filename for each window:

```sh
PWE_OBSERVER="$HOME/.local/share/pwe-observation"
PWE_DEPLOYED_REPO=$(systemctl --user show pi-wallpaper-engine.service --property=WorkingDirectory --value)
mkdir -p "$PWE_OBSERVER/runs"
umask 077
nohup python3 "$PWE_OBSERVER/observe.py" observe \
  --label original --duration 86400 --interval 30 \
  --repo "$PWE_DEPLOYED_REPO" \
  --config "$HOME/.config/pi-wallpaper-engine/config.json" \
  --db "$HOME/.local/state/pi-wallpaper-engine/pi-wallpaper-engine.db" \
  --output "$PWE_OBSERVER/runs/original-YYYYMMDD.jsonl" \
  > "$PWE_OBSERVER/runs/original-YYYYMMDD.stderr" 2>&1 < /dev/null &
PWE_OBSERVER_PID=$!
printf '%s\n' "$PWE_OBSERVER_PID"
```

Adjust the database path if the service uses `XDG_STATE_HOME`. `--config` must
refer to the deployed service's config, including a `PWE_CONFIG` override when
present. The collector exports only selected configuration fields, not secrets,
command argv, origins, media filenames, environment blocks or command lines.
Configured cache fields are recorded as supplied; omitted defaults depend on
the deployed revision. Actual mpv cache limits are measured through IPC. CLI
binary version probes identify installed binaries, not proof of the running
service's executable version. Worker activation stays unknown because the
sampler environment does not establish the service's environment.

Use ordinary application controls as usual. Do not force a download, playback,
network disruption or restart to fill missing coverage. The sampler survives a
SSH disconnect with `nohup`; a Pi reboot ends the window. To stop early, send
SIGTERM to the saved sampler PID; the final record marks the run interrupted.
The output is created exclusively and cannot overwrite/append an existing run.

## Retrieve and reproduce

Fetch the JSONL and stderr files by SFTP. Produce the report locally:

```sh
python3 scripts/observation/observe.py report original-YYYYMMDD.jsonl > original-summary.json
```

For a candidate day, repeat with a different filename and `--label candidate`
after ticket 06 permits deployment. Retain each complete JSONL and the collector
revision/hash used. Compare identical scene keys and measurement definitions,
including PSS plus SwapPss, CPU, sample counts, peaks and missing coverage.
Do not compare only daily medians when the usage mix differs.

## Interpretation

- `complete_24h_window` requires a duration-ended run covering at least 24 hours,
  boundary samples within 45 seconds, no gap over 1.5 sampling intervals
  (capped at 45 seconds), no collection errors or malformed records, and no
  observed deployed revision/dirty-state change. Initial and final revision and
  dirty-state provenance must both be present and successfully verified.
  `sampling_window_complete` describes timing/collection coverage separately;
  `source_provenance_verified` and `source_provenance_errors` identify source
  verification failures. Optional library/version errors remain visible in
  `optional_provenance_errors` without invalidating an otherwise verified day.
  A complete window can still lack scenes; inspect `missing_coverage` and
  property errors separately.
- Scenes distinguish playing, paused, stopped with a retained player, and
  released player, combined with probed display and observed intake activity.
  A 30-second poll can miss the entire stop grace period, brief intake children,
  transient buffering, or control transitions. The report never fills those in.
- Application memory sums the backend and observed descendants, including
  SteamCMD/box86 intake. PID/start-tick identities track reuse and service
  generations; previously observed descendants remain tracked if reparented.
  Unrelated processes and sampler memory stay outside the application total.
  A vanished/unreadable process invalidates that sample's memory total.
- CPU comes from raw user+system ticks and monotonic elapsed time. `100%` means
  one core; machine percentage divides by online CPUs. Intervals with changed
  process membership, scene, boot or a gap are excluded. Short-lived child CPU
  and peaks can be missed; a day without intake is not evidence of its cost.
- Cache reports use mpv's actual cache bytes and limits. Quality counts positive
  drop deltas within observed player generations, includes the known new value
  when a counter decreases, separately records resets,
  and reports sampled cache pauses/transitions. This cannot establish every
  underrun, smoothness between polls, first presentation latency or no leaks.
- Sampler CPU, PSS plus SwapPss and sampling duration are reported separately.
  System available/cache/swap memory, swap/major-fault/OOM counters and available
  PSI are external-pressure context, not application allocation or savings.
  Null/missing PSI is missing kernel support or access, not zero pressure.
  Kernel/GPU memory and cgroup cache attribution remain outside this accounting.
- Library codec/resolution groups are stored metadata, with completed optimized
  groups identified separately. Observed mpv media/decoding/output properties
  describe actual playback samples. Unplayed media and bitrate inventory need
  separate ticket 06 inspection; nothing is transcoded by this collector.

Run the synthetic CLI and real Unix-socket boundary checks locally with:

```sh
python3 -m unittest discover -s scripts/observation -v
```
