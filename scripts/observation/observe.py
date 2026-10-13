#!/usr/bin/env python3
"""Passive Linux resource observation. All output is JSON, never environment/cmdline."""
import argparse
import json
import os
import socket
import subprocess
import signal
import sqlite3
import hashlib
import pathlib
import time
import math
import statistics
from collections import Counter, defaultdict


def counters(text):
    result = {}
    for line in text.splitlines():
        key, _, value = line.partition(':')
        if value.strip():
            result[key] = int(value.split()[0])
    return result


def processes(proc):
    result = {}
    for path in proc.iterdir():
        if not path.name.isdigit():
            continue
        try:
            text = (path / 'stat').read_text()
            prefix, _, fields = text.rpartition(') ')
            fields = fields.split()
            pid = int(path.name)
            result[pid] = dict(pid=pid, comm=prefix.partition('(')[2], ppid=int(fields[1]),
                               start_ticks=int(fields[19]), cpu_ticks=int(fields[11]) + int(fields[12]))
        except (OSError, ValueError, IndexError):
            continue
    return result


def safe_read(path):
    try:
        return path.read_text().strip()
    except OSError:
        return None


def sample(args, known=None):
    started = time.monotonic()
    proc = pathlib.Path(args.proc_root)
    table = processes(proc)
    selected = {args.main_pid} if args.main_pid in table else set()
    selected |= {pid for pid, generation in (known or {}).items() if pid in table and table[pid]['start_ticks'] == generation}
    while True:
        children = {pid for pid, item in table.items() if item['ppid'] in selected}
        if children <= selected:
            break
        selected |= children
    output = []
    errors = []
    for pid in sorted(selected):
        item = table[pid]
        item['role'] = 'backend' if pid == args.main_pid else ('mpv' if item['comm'] == 'mpv' else 'intake' if item['comm'].startswith(('steamcmd', 'box86')) else 'helper')
        try:
            memory = counters((proc / str(pid) / 'smaps_rollup').read_text())
            item.update(pss_kib=memory['Pss'], swap_pss_kib=memory['SwapPss'], rss_kib=memory['Rss'])
            current = (proc / str(pid) / 'stat').read_text().rpartition(') ')[2].split()
            if int(current[19]) != item['start_ticks']:
                raise ValueError('process-replaced-during-sample')
        except (OSError, KeyError, ValueError, IndexError):
            errors.append(f'process:{pid}:memory-unavailable')
        output.append(item)
    if args.main_pid not in table:
        errors.append('backend:unavailable')
    complete = bool(selected) and not errors
    total = lambda key: sum(item[key] for item in output) if complete else None
    result = dict(kind='sample', monotonic_s=time.monotonic(), utc_s=time.time(),
                processes=output, app=dict(pss_kib=total('pss_kib'), swap_pss_kib=total('swap_pss_kib')),
                scene=dict(playback='unknown', display='unknown', download_intake=any(p['role'] == 'intake' for p in output)),
                system=dict(memory_kib=counters((proc / 'meminfo').read_text())), errors=errors)
    stat = (proc / 'stat').read_text().splitlines()
    cpu = [int(n) for n in stat[0].split()[1:]]
    result['system'].update(cpu_ticks=cpu, cpu_ticks_total=sum(cpu[:8]),
                            cpu_count=sum(line.startswith('cpu') and line[3:4].isdigit() for line in stat))
    result['boot_id'] = safe_read(proc / 'sys/kernel/random/boot_id')
    vmstat = safe_read(proc / 'vmstat')
    result['system']['vmstat'] = {parts[0]: int(parts[1]) for line in (vmstat or '').splitlines()
                                  if len(parts := line.split()) == 2}
    result['system']['pressure'] = {key: safe_read(proc / 'pressure' / key) for key in ('cpu', 'memory', 'io')}
    result['system']['loadavg'] = safe_read(proc / 'loadavg')
    sampler = table.get(os.getpid(), dict(pid=os.getpid(), cpu_ticks=None, start_ticks=None))
    try:
        own = counters((proc / str(os.getpid()) / 'smaps_rollup').read_text())
        sampler.update(pss_kib=own['Pss'], swap_pss_kib=own['SwapPss'])
    except (OSError, KeyError, ValueError, IndexError):
        sampler['memory_unavailable'] = True
    result['sampler'] = sampler
    result['sampler_elapsed_ms'] = (time.monotonic() - started) * 1000
    return result


MPV_PROPERTIES = ('idle-active', 'pause', 'time-pos', 'duration', 'video-codec', 'video-params',
                  'video-out-params', 'estimated-vf-fps', 'container-fps', 'hwdec-current',
                  'fullscreen', 'panscan', 'video-unscaled', 'demuxer-cache-state',
                  'demuxer-max-bytes', 'demuxer-max-back-bytes', 'paused-for-cache',
                  'cache-buffering-state', 'frame-drop-count', 'decoder-frame-drop-count', 'vo-delayed-frame-count')


def mpv_snapshot(path):
    # One connection per snapshot, only get_property commands. No subscriptions/state changes.
    values, errors = {}, []
    try:
        with socket.socket(socket.AF_UNIX) as connection:
            connection.settimeout(2)
            connection.connect(path)
            payload = ''.join(json.dumps(dict(command=['get_property', key], request_id=index)) + '\n'
                              for index, key in enumerate(MPV_PROPERTIES, 1))
            connection.sendall(payload.encode())
            pending = set(range(1, len(MPV_PROPERTIES) + 1))
            buffer = b''
            deadline = time.monotonic() + 2
            while pending and time.monotonic() < deadline:
                connection.settimeout(max(.001, deadline - time.monotonic()))
                chunk = connection.recv(65536)
                if not chunk:
                    break
                buffer += chunk
                if len(buffer) > 1048576:
                    raise ValueError('response-too-large')
                while b'\n' in buffer:
                    line, buffer = buffer.split(b'\n', 1)
                    response = json.loads(line)
                    index = response.get('request_id')
                    if index in pending:
                        pending.remove(index)
                        key = MPV_PROPERTIES[index - 1]
                        if response.get('error') == 'success':
                            values[key] = response.get('data')
                        else:
                            errors.append(key + ':unavailable')
            errors.extend(MPV_PROPERTIES[index - 1] + ':missing-response' for index in pending)
    except (OSError, ValueError):
        errors.append('ipc:unavailable')
    return dict(values=values, errors=errors)


def command_output(argv, timeout=3):
    # Never copy arbitrary stderr/stdout into observation errors.
    result = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise ValueError('command-failed')
    return result.stdout.strip()


def provenance(args, config):
    result = dict(kind='metadata', schema_version=1, label=args.label, interval_s=args.interval,
                  requested_duration_s=args.duration, clock_ticks_per_s=os.sysconf('SC_CLK_TCK'),
                  utc_s=time.time(), monotonic_s=time.monotonic(),
                  sampler_sha256=hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),
                  python_version=os.sys.version.split()[0], machine=os.uname().machine,
                  kernel=os.uname().release, effective_config={}, errors=[])
    for section, keys in {'mpv': ('hwdec', 'gpu_api', 'cache_forward_mib', 'cache_backward_mib'),
                          'screen': ('width', 'height', 'default_display_mode'), 'auth': ('enabled',)}.items():
        result['effective_config'][section] = {key: config.get(section, {})[key] for key in keys if key in config.get(section, {})}
    result['display_probe_enabled'] = args.probe_display
    result['configured_cache_defaults'] = 'unset values depend on deployed revision; use observed IPC limits'
    for binary, argv in [('bun', ['bun', '--version']), ('mpv', [config.get('mpv', {}).get('binary_path', 'mpv'), '--version'])]:
        try:
            result[binary + '_version'] = command_output(argv).splitlines()[0]
        except (OSError, ValueError, IndexError, subprocess.TimeoutExpired):
            result['errors'].append(binary + ':version-unavailable')
    result['worker_enabled'] = None  # The sampler environment does not establish the backend's worker mode.
    # Record only scalar feature flags, never keys, command argv, origin URLs or media paths.
    if args.repo:
        try:
            result['deployed_revision'] = command_output(['git', '-C', args.repo, 'rev-parse', 'HEAD'])
            result['deployed_dirty'] = bool(command_output(['git', '-C', args.repo, 'status', '--porcelain']))
        except (OSError, ValueError, subprocess.TimeoutExpired):
            result['errors'].append('revision:unavailable')
    if args.db:
        try:
            uri = pathlib.Path(args.db).resolve().as_uri() + '?mode=ro'
            with sqlite3.connect(uri, uri=True, timeout=1) as db:
                columns = {row[1] for row in db.execute('PRAGMA table_info(library)')}
                category_keys = [key for key in ('source_codec', 'source_resolution', 'transcoded_codec', 'transcoded_resolution') if key in columns]
                result['library_items'] = db.execute('SELECT COUNT(*) FROM library').fetchone()[0]
                result['media_category_source'] = 'stored-library-metadata'
                result['media_categories'] = [dict(zip(category_keys + ['count'], row)) for row in
                    db.execute('SELECT ' + ','.join(category_keys) + ', COUNT(*) FROM library GROUP BY ' + ','.join(category_keys))] if category_keys else []
                if {'transcode_status', 'transcoded_path', 'transcoded_codec', 'transcoded_resolution'} <= columns:
                    result['completed_optimized_categories'] = [dict(codec=row[0], resolution=row[1], count=row[2]) for row in db.execute(
                        "SELECT transcoded_codec,transcoded_resolution,COUNT(*) FROM library WHERE transcode_status='completed' AND transcoded_path IS NOT NULL GROUP BY transcoded_codec,transcoded_resolution")]
                if not category_keys:
                    result['errors'].append('library:media-categories-unavailable')
        except (sqlite3.Error, OSError, ValueError):
            result['errors'].append('library:unavailable')
    return result


def observe(args):
    config = {}
    if args.config:
        config = json.loads(pathlib.Path(args.config).read_text())
    stopped = [False]
    signal.signal(signal.SIGTERM, lambda *_: stopped.__setitem__(0, True))
    signal.signal(signal.SIGINT, lambda *_: stopped.__setitem__(0, True))
    known = {}
    start = time.monotonic()
    with open(args.output, 'x', buffering=1) as output:
        os.chmod(args.output, 0o600)
        emit = lambda record: output.write(json.dumps(record, sort_keys=True) + '\n')
        metadata = provenance(args, config)
        emit(metadata)
        next_at = start
        while not stopped[0]:
            cycle_started = time.monotonic()
            try:
                if args.main_pid is None:
                    main_pid = int(command_output(['systemctl', '--user', 'show', args.service, '--property=MainPID', '--value']))
                else:
                    main_pid = args.main_pid
                sample_args = argparse.Namespace(proc_root=args.proc_root, main_pid=main_pid)
                snapshot = sample(sample_args, known)
                known = {process['pid']: process['start_ticks'] for process in snapshot['processes']}
            except (OSError, ValueError, subprocess.TimeoutExpired):
                emit(dict(kind='error', utc_s=time.time(), monotonic_s=time.monotonic(), error='sample:failed'))
                snapshot = None
            if snapshot:
                if args.repo:
                    try:
                        snapshot['deployed_revision'] = command_output(['git', '-C', args.repo, 'rev-parse', 'HEAD'])
                    except (OSError, ValueError, subprocess.TimeoutExpired):
                        snapshot['errors'].append('revision:unavailable')
                players = [p for p in snapshot['processes'] if p['role'] == 'mpv']
                if len(players) > 1:
                    snapshot['errors'].append('mpv:multiple-processes')
                player = next((p for p in players if p['ppid'] == main_pid), players[0] if players else None)
                if player:
                    path = args.mpv_socket or config.get('mpv', {}).get('ipc_socket')
                    state = mpv_snapshot(path) if path else dict(values={}, errors=['ipc:path-unavailable'])
                    state['generation'] = str(player['pid']) + ':' + str(player['start_ticks'])
                    snapshot['mpv'] = state
                    values = state['values']
                    if values.get('idle-active') is True:
                        snapshot['scene']['playback'] = 'stopped'
                    elif values.get('idle-active') is False and isinstance(values.get('pause'), bool):
                        snapshot['scene']['playback'] = 'paused' if values['pause'] else 'playing'
                    if state['errors']:
                        snapshot['errors'].extend('mpv:' + error for error in state['errors'] if error.startswith('ipc:'))
                else:
                    snapshot['scene']['playback'] = 'released' if any(p['pid'] == main_pid for p in snapshot['processes']) else 'unknown'
                if args.probe_display:
                    argv = config.get('display', {}).get('status_command')
                    if argv:
                        try:
                            status = subprocess.run(argv, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3, stdin=subprocess.DEVNULL)
                            snapshot['scene']['display'] = 'on' if status.returncode == 0 else 'off' if status.returncode > 0 else 'unknown'
                        except (OSError, subprocess.TimeoutExpired):
                            snapshot['errors'].append('display:probe-failed')
                    else:
                        snapshot['errors'].append('display:probe-unconfigured')
                snapshot['sampler_elapsed_ms'] = (time.monotonic() - cycle_started) * 1000
                emit(snapshot)
            elapsed = time.monotonic() - start
            if elapsed >= args.duration:
                break
            next_at = min(next_at + args.interval, start + args.duration)
            while not stopped[0] and time.monotonic() < next_at:
                time.sleep(min(1, next_at - time.monotonic()))
        final = provenance(args, config)
        emit(dict(kind='end', final_revision=final.get('deployed_revision'), final_dirty=final.get('deployed_dirty'),
                  provenance_errors=final['errors'], utc_s=time.time(), elapsed_s=time.monotonic() - start,
                  reason='signal' if stopped[0] else 'duration', monotonic_s=time.monotonic()))


def distribution(values):
    values = sorted(values)
    if not values:
        return dict(n=0, min=None, median=None, p95=None, max=None)
    return dict(n=len(values), min=values[0], median=statistics.median(values),
                p95=values[max(0, math.ceil(len(values) * .95) - 1)], max=values[-1])


def scene_key(sample):
    scene = sample['scene']
    return scene['playback'] + '/display-' + scene['display'] + ('/download-intake' if scene['download_intake'] else '')


def report(path):
    records = []
    malformed = []
    with open(path) as source:
        for number, line in enumerate(source, 1):
            try:
                records.append(json.loads(line))
            except ValueError:
                malformed.append(number)
    metadata = [r for r in records if r.get('kind') == 'metadata']
    meta = metadata[0] if metadata else {}
    samples = [r for r in records if r.get('kind') == 'sample']
    ends = [r for r in records if r.get('kind') == 'end']
    interval = meta.get('interval_s', 30)
    rate = meta.get('clock_ticks_per_s', 100)
    grouped = defaultdict(lambda: defaultdict(list))
    gaps, generations, player_generations = [], set(), set()
    environment = defaultdict(list)
    overhead = defaultdict(list)
    property_errors = Counter()
    observed_media = Counter()
    revisions = {r['deployed_revision'] for r in records if r.get('deployed_revision')}
    revisions.update(r['final_revision'] for r in ends if r.get('final_revision'))
    cache_pauses = dict(observed_samples=0, active_samples=0, observed_false_to_true=0)
    errors = Counter(r.get('error', 'sample:failed') for r in records if r.get('kind') == 'error')
    quality = {key: dict(observed_positive_deltas=0, resets=0, observed_intervals=0) for key in ('frame-drop-count', 'decoder-frame-drop-count', 'vo-delayed-frame-count')}
    previous = None
    for sample in samples:
        key = scene_key(sample)
        group = grouped[key]
        group['samples'].append(1)
        for metric in ('pss_kib', 'swap_pss_kib'):
            value = sample['app'].get(metric)
            if value is not None:
                group[metric.replace('_kib', '_mib')].append(value / 1024)
        pss, swap = sample['app'].get('pss_kib'), sample['app'].get('swap_pss_kib')
        if pss is not None and swap is not None:
            group['memory_pss_plus_swap_mib'].append((pss + swap) / 1024)
        errors.update(sample.get('errors', []))
        for process in sample['processes']:
            if process['role'] == 'backend':
                generations.add((sample.get('boot_id'), process['pid'], process['start_ticks']))
        state = sample.get('mpv', {})
        if state.get('generation'):
            player_generations.add((sample.get('boot_id'), state['generation']))
        property_errors.update(state.get('errors', []))
        values = state.get('values', {})
        if values.get('video-codec'):
            observed_media[json.dumps({key: values.get(key) for key in ('video-codec', 'video-params', 'video-out-params',
                                      'hwdec-current', 'container-fps', 'estimated-vf-fps', 'fullscreen', 'panscan', 'video-unscaled')}, sort_keys=True)] += 1
        cache = values.get('demuxer-cache-state') or {}
        for metric, source in (('actual_cache_mib', cache.get('total-bytes')),
                               ('cache_forward_limit_mib', values.get('demuxer-max-bytes')),
                               ('cache_backward_limit_mib', values.get('demuxer-max-back-bytes'))):
            if isinstance(source, (int, float)):
                group[metric].append(source / 1048576)
        if isinstance(values.get('paused-for-cache'), bool):
            cache_pauses['observed_samples'] += 1
            cache_pauses['active_samples'] += int(values['paused-for-cache'])
        own = sample.get('sampler', {})
        if own.get('pss_kib') is not None and own.get('swap_pss_kib') is not None:
            overhead['pss_plus_swap_mib'].append((own['pss_kib'] + own['swap_pss_kib']) / 1024)
        if sample.get('sampler_elapsed_ms') is not None:
            overhead['sample_elapsed_ms'].append(sample['sampler_elapsed_ms'])
        memory = sample.get('system', {}).get('memory_kib', {})
        for metric in ('MemAvailable', 'MemFree', 'Cached', 'Buffers', 'SReclaimable', 'Shmem'):
            if metric in memory:
                environment[metric + '_mib'].append(memory[metric] / 1024)
        for resource, pressure in sample.get('system', {}).get('pressure', {}).items():
            for line in (pressure or '').splitlines():
                scope, *parts = line.split()
                fields = dict(part.split('=', 1) for part in parts)
                if 'avg10' in fields:
                    environment['psi_' + resource + '_' + scope + '_avg10_pct'].append(float(fields['avg10']))
        if 'SwapTotal' in memory and 'SwapFree' in memory:
            environment['swap_used_mib'].append((memory['SwapTotal'] - memory['SwapFree']) / 1024)
        for role in ('backend', 'mpv', 'intake', 'helper'):
            members = [p for p in sample['processes'] if p['role'] == role]
            if members and all('pss_kib' in p and 'swap_pss_kib' in p for p in members):
                group[role + '_pss_plus_swap_mib'].append(sum(p['pss_kib'] + p['swap_pss_kib'] for p in members) / 1024)

        for flag in ('paused-for-cache', 'cache-buffering-state'):
            if flag in values:
                group[flag].append(values[flag])
        for metric in ('sampler_elapsed_ms',):
            if metric in sample:
                group[metric].append(sample[metric])
        if previous:
            seconds = sample['monotonic_s'] - previous['monotonic_s']
            contiguous = 0 < seconds <= min(interval * 1.5, 45) and sample.get('boot_id') == previous.get('boot_id')
            if not contiguous:
                gaps.append(dict(after_utc_s=previous['utc_s'], before_utc_s=sample['utc_s'], seconds=seconds))
            if contiguous:
                old_self = previous.get('sampler', {})
                if own.get('pid') == old_self.get('pid') and own.get('start_ticks') == old_self.get('start_ticks'):
                    current_cpu, old_cpu = own.get('cpu_ticks'), old_self.get('cpu_ticks')
                    if current_cpu is not None and old_cpu is not None and current_cpu >= old_cpu:
                        overhead['cpu_one_core_pct'].append(100 * (current_cpu - old_cpu) / rate / seconds)
                current_ticks = sample.get('system', {}).get('cpu_ticks', [])
                old_ticks = previous.get('system', {}).get('cpu_ticks', [])
                if len(current_ticks) >= 5 and len(old_ticks) >= 5:
                    delta_ticks = sum(current_ticks[:8]) - sum(old_ticks[:8])
                    idle_delta = current_ticks[3] + current_ticks[4] - old_ticks[3] - old_ticks[4]
                    if delta_ticks > 0:
                        environment['cpu_busy_machine_pct'].append(100 * (delta_ticks - idle_delta) / delta_ticks)
                for metric in ('pswpin', 'pswpout', 'pgmajfault', 'oom_kill'):
                    current_count = sample.get('system', {}).get('vmstat', {}).get(metric)
                    old_count = previous.get('system', {}).get('vmstat', {}).get(metric)
                    if current_count is not None and old_count is not None and current_count >= old_count:
                        environment[metric + '_delta'].append(current_count - old_count)
                before = {(p['pid'], p['start_ticks']): p for p in previous['processes']}
                after = {(p['pid'], p['start_ticks']): p for p in sample['processes']}
                # CPU is valid only for unchanged process membership and scene.
                if before and before.keys() == after.keys() and scene_key(previous) == key:
                    delta = sum(after[p]['cpu_ticks'] - before[p]['cpu_ticks'] for p in after)
                    if delta >= 0:
                        group['cpu_one_core_pct'].append(100 * delta / rate / seconds)
                        group['cpu_machine_pct'].append(100 * delta / rate / seconds / sample['system'].get('cpu_count', 1))
                old_mpv = previous.get('mpv', {})
                if state.get('generation') == old_mpv.get('generation'):
                    if values.get('paused-for-cache') is True and old_mpv.get('values', {}).get('paused-for-cache') is False:
                        cache_pauses['observed_false_to_true'] += 1
                    for metric, counter in quality.items():
                        current, old = values.get(metric), old_mpv.get('values', {}).get(metric)
                        if isinstance(current, (int, float)) and isinstance(old, (int, float)):
                            counter['observed_intervals'] += 1
                            counter['observed_positive_deltas'] += max(0, current - old)
                            counter['resets'] += int(current < old)
        previous = sample
    elapsed = samples[-1]['monotonic_s'] - samples[0]['monotonic_s'] if len(samples) > 1 else 0
    observed = {sample['scene']['playback'] for sample in samples}
    if any(s['scene']['display'] == 'off' for s in samples):
        observed.add('display-off')
    if any(s['scene']['download_intake'] for s in samples):
        observed.add('download-intake')
    dirty_changed = len(ends) == 1 and ends[0].get('final_dirty') != meta.get('deployed_dirty')
    closed = len(ends) == 1 and ends[0].get('reason') == 'duration' and ends[0].get('elapsed_s', 0) >= 86400
    tolerance = min(interval * 1.5, 45)
    edges_covered = bool(samples) and samples[0]['monotonic_s'] - meta.get('monotonic_s', samples[0]['monotonic_s']) <= tolerance
    edges_covered = edges_covered and closed and ends[0].get('monotonic_s', samples[-1]['monotonic_s']) - samples[-1]['monotonic_s'] <= tolerance
    return dict(label=meta.get('label'), metadata=meta, samples=len(samples), sampled_span_s=elapsed,
                complete_24h_window=elapsed >= 86400 - min(interval, 30) and len(metadata) == 1 and closed and edges_covered
                    and not gaps and not malformed and not errors and len(revisions) <= 1 and not dirty_changed,
                deployed_dirty_changed=dirty_changed,
                deployed_revisions=sorted(revisions), revision_changed=len(revisions) > 1,
                malformed_lines=malformed, gaps=gaps, errors=dict(errors), backend_generations=len(generations),
                missing_coverage=sorted({'playing', 'paused', 'stopped', 'display-off', 'download-intake'} - observed),
                mpv_generations=len(player_generations), mpv_property_errors=dict(property_errors),
                quality=quality, cache_pauses=cache_pauses,
                observed_media=[dict(properties=json.loads(key), samples=count) for key, count in observed_media.items()],
                sampler={key: distribution(values) for key, values in overhead.items()},
                system={key: distribution(values) for key, values in environment.items()},
                scenes={key: {metric: len(values) if metric == 'samples' else distribution(values)
                               for metric, values in group.items()} for key, group in grouped.items()},
                limits=['Polling can miss brief subprocesses and buffering between samples.',
                        'Drops are summed within observed player generations; resets and gaps lose evidence.',
                        'CPU excludes intervals with changed membership, scene or sampling gaps.',
                        'Unknown display state cannot establish display-off coverage.',
                        'Library categories are stored metadata, not new ffprobe inspection; bitrate inventory remains unmeasured.',
                        'Thirty-second sampling may miss the stopped grace period and transient download peaks.',
                        'Cache pauses count observed states/transitions, not every underrun event.',
                        'PSS+SwapPss excludes kernel/GPU memory and must not be added to filesystem cache.',
                        'This report does not establish first presentation latency or absence of leaks.'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    single = commands.add_parser('sample')
    single.add_argument('--proc-root', default='/proc')
    single.add_argument('--main-pid', type=int, required=True)
    daily = commands.add_parser('observe')
    daily.add_argument('--output', required=True)
    daily.add_argument('--label', required=True, help='original, candidate, or explicit synthetic label')
    daily.add_argument('--duration', type=float, default=86400)
    daily.add_argument('--interval', type=float, default=30)
    daily.add_argument('--service', default='pi-wallpaper-engine.service')
    daily.add_argument('--main-pid', type=int, help='fixed PID for isolated diagnostic runs')
    daily.add_argument('--proc-root', default='/proc')
    daily.add_argument('--mpv-socket')
    daily.add_argument('--config')
    daily.add_argument('--repo', help='deployed repository, used only for revision/dirty provenance')
    daily.add_argument('--db', help='optional SQLite library read-only metadata')
    daily.add_argument('--probe-display', action='store_true', help='explicitly enable configured status_command after checking it is read-only')
    summary = commands.add_parser('report')
    summary.add_argument('source')
    args = parser.parse_args()
    if args.command == 'observe':
        if args.duration < 0 or args.interval <= 0:
            parser.error('duration must be nonnegative and interval must be positive')
        observe(args)
    else:
        print(json.dumps(report(args.source) if args.command == 'report' else sample(args), sort_keys=True))


if __name__ == '__main__':
    main()
