"""Tests exercise the collector/report CLI with synthetic Linux counters, not Pi evidence."""
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest
import socket
import threading

SCRIPT = pathlib.Path(__file__).with_name('observe.py')


class ObservationCLI(unittest.TestCase):
    def test_collects_descendants_without_exposing_command_lines(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / 'stat').write_text('cpu 100 0 50 850 0 0 0 0 0 0\ncpu0 100 0 50 850\n')
            (root / 'meminfo').write_text('MemTotal: 4096 kB\nMemAvailable: 2048 kB\nSwapTotal: 1024 kB\nSwapFree: 512 kB\nCached: 128 kB\n')
            for pid, parent, name, pss, swap in [(10, 1, 'bun', 100, 30), (11, 10, 'mpv', 200, 40), (12, 10, 'box86', 50, 5), (13, 12, 'steamcmd', 25, 10), (99, 1, 'unrelated', 900, 90)]:
                process = root / str(pid)
                process.mkdir()
                fields = ['S', str(parent)] + ['0'] * 48
                fields[11:13] = ['20', '10']
                fields[19] = str(1000 + pid)
                (process / 'stat').write_text(f'{pid} ({name}) ' + ' '.join(fields))
                (process / 'smaps_rollup').write_text(f'Rss: {pss + 20} kB\nPss: {pss} kB\nSwapPss: {swap} kB\n')
                (process / 'cmdline').write_text('SECRET_DO_NOT_READ')
            result = subprocess.run([sys.executable, str(SCRIPT), 'sample', '--proc-root', str(root), '--main-pid', '10'], text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            sample = json.loads(result.stdout)
            self.assertEqual(sample['app']['pss_kib'], 375)
            self.assertEqual(sample['app']['swap_pss_kib'], 85)
            self.assertEqual({p['pid'] for p in sample['processes']}, {10, 11, 12, 13})
            self.assertEqual(sample['scene']['download_intake'], True)
            self.assertNotIn('SECRET', result.stdout)

    def test_observe_records_a_closed_window_and_sampler_failures_without_hiding_them(self):
        with tempfile.TemporaryDirectory() as directory:
            output = pathlib.Path(directory) / 'observations.jsonl'
            proc = pathlib.Path(directory) / 'proc'
            proc.mkdir()
            (proc / 'meminfo').write_text('MemTotal: 4096 kB\n')
            (proc / 'stat').write_text('cpu 100 0 50 850\ncpu0 100 0 50 850\n')
            result = subprocess.run([sys.executable, str(SCRIPT), 'observe', '--output', str(output),
                                     '--label', 'synthetic', '--proc-root', str(proc), '--main-pid', '987654321', '--duration', '0',
                                     '--interval', '30'], text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            records = [json.loads(line) for line in output.read_text().splitlines()]
            self.assertEqual([r['kind'] for r in records], ['metadata', 'sample', 'end'])
            self.assertIn('backend:unavailable', records[1]['errors'])
            self.assertIn('sampler', records[1])
            self.assertEqual(records[-1]['reason'], 'duration')
            second = subprocess.run([sys.executable, str(SCRIPT), 'observe', '--output', str(output),
                                     '--label', 'synthetic', '--duration', '0'], text=True, capture_output=True)
            self.assertNotEqual(second.returncode, 0)

    def test_ipc_observation_is_read_only_and_config_secrets_stay_private(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            proc = root / 'proc'
            proc.mkdir()
            (proc / 'meminfo').write_text('MemTotal: 4096 kB\n')
            (proc / 'stat').write_text('cpu 100 0 50 850\ncpu0 100 0 50 850\n')
            for pid, parent, name in [(10, 1, 'bun'), (11, 10, 'mpv')]:
                path = proc / str(pid)
                path.mkdir()
                fields = ['S', str(parent)] + ['0'] * 48
                fields[19] = '100'
                (path / 'stat').write_text(f'{pid} ({name}) ' + ' '.join(fields))
                (path / 'smaps_rollup').write_text('Rss: 100 kB\nPss: 80 kB\nSwapPss: 10 kB\n')
            output = root / 'raw.jsonl'
            sock_path = root / 'mpv.sock'
            config = root / 'config.json'
            config.write_text(json.dumps(dict(mpv=dict(ipc_socket=str(sock_path), hwdec='auto'),
                                              steam=dict(api_key='SECRET_CONFIG'), display=dict(on_command=['SECRET_COMMAND']))))
            requests = []
            failures = []
            with socket.socket(socket.AF_UNIX) as server:
                server.bind(str(sock_path))
                server.listen(1)
                server.settimeout(5)
                def respond():
                    try:
                        connection, _ = server.accept()
                        with connection, connection.makefile('rb') as stream:
                            while True:
                                line = stream.readline()
                                if not line:
                                    break
                                request = json.loads(line)
                                requests.append(request['command'])
                                key = request['command'][1]
                                data = {'idle-active': False, 'pause': True, 'frame-drop-count': 3,
                                        'demuxer-cache-state': {'total-bytes': 1048576}}.get(key)
                                connection.sendall((json.dumps(dict(request_id=request['request_id'], error='success', data=data)) + '\n').encode())
                    except Exception as error:
                        failures.append(str(error))
                worker = threading.Thread(target=respond)
                worker.start()
                result = subprocess.run([sys.executable, str(SCRIPT), 'observe', '--output', str(output),
                                         '--label', 'synthetic', '--main-pid', '10', '--proc-root', str(proc),
                                         '--config', str(config), '--duration', '0'], text=True, capture_output=True)
                worker.join(6)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(worker.is_alive())
            self.assertEqual(failures, [])
            self.assertTrue(requests)
            self.assertTrue(all(command[0] == 'get_property' for command in requests))
            raw = output.read_text()
            self.assertNotIn('SECRET', raw)
            records = [json.loads(line) for line in raw.splitlines()]
            self.assertEqual(records[1]['scene']['playback'], 'paused')
            self.assertEqual(self.report(records)['scenes']['paused/display-unknown']['actual_cache_mib']['median'], 1)

    def report(self, records):
        with tempfile.TemporaryDirectory() as directory:
            source = pathlib.Path(directory) / 'observations.jsonl'
            source.write_text(''.join(json.dumps(record) + '\n' for record in records))
            result = subprocess.run([sys.executable, str(SCRIPT), 'report', str(source)], text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)

    def test_report_keeps_swap_and_counter_resets_and_exposes_missing_scenes(self):
        def item(at, ticks, drops, generation):
            return dict(kind='sample', monotonic_s=at, utc_s=at, app=dict(pss_kib=100, swap_pss_kib=50),
                        processes=[dict(pid=10, start_ticks=generation, cpu_ticks=ticks, role='backend')],
                        system=dict(cpu_ticks_total=at * 100, cpu_count=4),
                        scene=dict(playback='playing', display='unknown', download_intake=False),
                        mpv=dict(generation='player1', values={'frame-drop-count': drops}), errors=[])
        report = self.report([dict(kind='metadata', interval_s=30, clock_ticks_per_s=100, label='synthetic'),
                              item(0, 100, 5, 1), item(30, 130, 8, 1), item(60, 10, 0, 2), item(90, 40, 2, 2)])
        self.assertFalse(report['complete_24h_window'])
        self.assertAlmostEqual(report['scenes']['playing/display-unknown']['memory_pss_plus_swap_mib']['median'], 150 / 1024)
        self.assertEqual(report['quality']['frame-drop-count']['observed_positive_deltas'], 5)
        self.assertEqual(report['backend_generations'], 2)
        self.assertIn('download-intake', report['missing_coverage'])
        self.assertIn('display-off', report['missing_coverage'])
        self.assertEqual(report['scenes']['playing/display-unknown']['cpu_one_core_pct']['median'], 1)

    def test_report_accepts_only_a_closed_full_window_and_preserves_collection_errors(self):
        records = [dict(kind='metadata', interval_s=30, clock_ticks_per_s=100, label='synthetic',
                        requested_duration_s=86400, monotonic_s=0)]
        for at in range(0, 86401, 30):
            records.append(dict(kind='sample', monotonic_s=at, utc_s=at,
                                app=dict(pss_kib=100, swap_pss_kib=0), processes=[], system={},
                                scene=dict(playback='released', display='unknown', download_intake=False), errors=[]))
        records.append(dict(kind='end', elapsed_s=86400, monotonic_s=86400, reason='duration'))
        self.assertTrue(self.report(records)['complete_24h_window'])
        records.insert(3, dict(kind='error', error='sample:failed'))
        self.assertFalse(self.report(records)['complete_24h_window'])

    def test_report_does_not_claim_full_day_across_a_sampling_gap(self):
        records = [dict(kind='metadata', interval_s=30, clock_ticks_per_s=100, label='synthetic')]
        for at in range(0, 86401, 30):
            if at == 300:
                continue
            records.append(dict(kind='sample', monotonic_s=at, utc_s=at,
                                app=dict(pss_kib=100, swap_pss_kib=0), processes=[],
                                system={}, scene=dict(playback='stopped', display='unknown', download_intake=False), errors=[]))
        records.append(dict(kind='end', elapsed_s=86400, reason='duration'))
        report = self.report(records)
        self.assertFalse(report['complete_24h_window'])
        self.assertEqual(len(report['gaps']), 1)


if __name__ == '__main__':
    unittest.main()
