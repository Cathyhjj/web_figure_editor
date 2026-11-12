"""Local bridge and MCP transport regression tests; synthetic sessions only."""
import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import http.client
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from automation_bridge import AutomationBridge, AutomationError, METHODS
from figure_mcp import AssetRoot, EditorClient, MCPServer, TOOLS, check_root_sources, validate
import server


SUMMARY = {"name": "Synthetic figure", "projectId": "project", "slideId": "slide", "revision": "1:0"}


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.bridge = AutomationBridge(command_timeout=.15, poll_timeout=.02)
        self.session = self.bridge.handle('register', {'summary': SUMMARY})['sessionId']

    def call(self, method='get_state'):
        return self.bridge.handle('command', {'sessionId': self.session, 'method': method, 'params': {}})

    def poll(self):
        return self.bridge.handle('poll', {'sessionId': self.session, 'summary': SUMMARY})['command']

    def test_commands_reach_only_selected_page_and_results_are_not_reexecuted(self):
        other = self.bridge.handle('register', {'summary': SUMMARY})['sessionId']
        with ThreadPoolExecutor() as pool:
            pending = pool.submit(self.call)
            self.assertIsNone(self.bridge.handle('poll', {'sessionId': other, 'summary': SUMMARY})['command'])
            command = self.poll()
            self.assertEqual(command['method'], 'get_state')
            self.assertIsNone(self.poll())
            reply = {'sessionId': self.session, 'commandId': command['id'], 'result': {'ok': True, 'value': {'revision': '1:2'}}}
            self.bridge.handle('result', reply)
            self.assertEqual(pending.result(), {'revision': '1:2'})
            self.bridge.handle('result', reply)
            self.assertIsNone(self.poll())

    def test_undelivered_timeout_removes_command(self):
        with self.assertRaisesRegex(AutomationError, 'not delivered'):
            self.call('history')
        self.assertIsNone(self.poll())

    def test_delivered_timeout_reports_uncertain_outcome_and_busy_rejects(self):
        with ThreadPoolExecutor() as pool:
            pending = pool.submit(self.call)
            self.assertIsNotNone(self.poll())
            with self.assertRaisesRegex(AutomationError, 'another command'):
                self.call()
            with self.assertRaisesRegex(AutomationError, 'outcome is unknown'):
                pending.result()

    def test_expired_and_disconnected_sessions_cannot_receive_edits(self):
        self.bridge.handle('disconnect', {'sessionId': self.session})
        with self.assertRaisesRegex(AutomationError, 'disconnected'):
            self.call()
        new = self.bridge.handle('register', {'summary': SUMMARY})['sessionId']
        self.bridge.sessions[new]['seen'] -= 100
        self.assertEqual(self.bridge.handle('sessions', {})['sessions'], [])

    def test_browser_failure_is_returned_as_failure(self):
        with ThreadPoolExecutor() as pool:
            pending = pool.submit(self.call)
            command = self.poll()
            self.bridge.handle('result', {'sessionId': self.session, 'commandId': command['id'], 'result': {'ok': False, 'error': 'Revision changed'}})
            with self.assertRaisesRegex(AutomationError, 'Revision changed'):
                pending.result()


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.http = server.create_server(self.directory.name, 0)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.origin = f'http://127.0.0.1:{self.http.server_port}'
        self.quiet = patch.object(server.Handler, 'log_message')
        self.quiet.start()

    def tearDown(self):
        self.http.shutdown(); self.thread.join(); self.http.server_close()
        self.quiet.stop(); self.directory.cleanup()

    def request(self, **changes):
        headers = {'Content-Type': 'application/json', 'Origin': self.origin, 'X-Figure-Token': self.http.token}
        headers.update(changes)
        connection = http.client.HTTPConnection('127.0.0.1', self.http.server_port)
        connection.request('POST', '/api/automation/sessions', '{}', headers)
        response = connection.getresponse()
        result = response.status, json.loads(response.read())
        connection.close()
        return result

    def test_authentication_origin_host_and_fetch_metadata_are_required(self):
        self.assertEqual(self.request()[0], 200)
        for headers in [{'Origin': 'https://example.com'}, {'X-Figure-Token': 'wrong'}, {'Host': 'evil.test'}, {'Sec-Fetch-Site': 'cross-site'}]:
            self.assertEqual(self.request(**headers)[0], 403)

    def test_real_adapter_discovers_sessions(self):
        client = EditorClient(self.http.server_port, self.directory.name)
        self.http.automation.handle('register', {'summary': SUMMARY})
        result = client.call('figure_sessions', {})
        self.assertEqual(result['structuredContent']['sessions'][0]['name'], SUMMARY['name'])
        self.assertNotIn(self.http.token, json.dumps(result))

    def test_large_import_command_reaches_only_selected_page_and_returns_metadata(self):
        client = EditorClient(self.http.server_port, self.directory.name, self.directory.name)
        raw = b'<svg xmlns="http://www.w3.org/2000/svg">' + b' ' * (1024 * 1024) + b'</svg>'
        Path(self.directory.name, 'plot.svg').write_bytes(raw)
        bridge = self.http.automation
        sid = bridge.handle('register', {'summary': SUMMARY})['sessionId']
        args = {'sessionId': sid, 'expectedRevision': '1:0', 'paths': ['plot.svg']}
        with ThreadPoolExecutor() as pool:
            pending = pool.submit(client.call, 'figure_import_assets', args)
            command = bridge.handle('poll', {'sessionId': sid, 'summary': SUMMARY})['command']
            params = command['params']
            self.assertEqual(command['method'], 'import_assets')
            self.assertEqual(params['expectedRevision'], '1:0')
            self.assertEqual(params['rootId'], client.asset_root.id)
            record, = params['files']
            self.assertEqual(base64.b64decode(record['data']), raw)
            self.assertEqual(record['fingerprint'], hashlib.sha256(raw).hexdigest())
            reply = {'revision': '1:1', 'assets': [{'assetId': 'a', 'relativePath': 'plot.svg'}]}
            bridge.handle('result', {'sessionId': sid, 'commandId': command['id'], 'result': {'ok': True, 'value': reply}})
            self.assertEqual(pending.result()['structuredContent'], reply)


class AssetRootTests(unittest.TestCase):
    def test_relative_paths_cannot_follow_links_or_open_special_files(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            allowed = base / 'allowed'
            allowed.mkdir()
            (base / 'outside.svg').write_bytes(b'<svg/>')
            (allowed / 'linked.svg').symlink_to(base / 'outside.svg')
            (allowed / 'linked_dir').symlink_to(base, target_is_directory=True)
            (allowed / 'directory.svg').mkdir()
            root = AssetRoot(allowed)
            for path in ('../outside.svg', '/outside.svg', 'linked.svg', 'linked_dir/outside.svg', 'directory.svg',
                         '.private/plot.svg', 'x/%2e%2e/plot.svg', 'C:\\plot.svg', 'plot.html', 'data:image/svg+xml', '~/plot.svg'):
                with self.subTest(path=path), self.assertRaises(ValueError):
                    root.import_files([path])

    def test_source_versions_share_one_disk_read_and_replaced_roots_are_not_used(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            allowed = base / 'images'
            allowed.mkdir()
            raw = b'<svg><path/></svg>'
            (allowed / 'file.svg').write_bytes(raw)
            root = AssetRoot(allowed)
            digest = hashlib.sha256(raw).hexdigest()
            row = {'assetId': '1', 'status': 'check_root', 'relativePath': 'file.svg', 'mcpRootId': root.id,
                   'fingerprint': 'sha256:' + digest, 'usedBy': [{'slideId': 's', 'itemId': 'i'}]}
            rows = [dict(row), {**row, 'assetId': '2', 'fingerprint': '0' * 64}, {**row, 'relativePath': 'absent.png'},
                    {**row, 'status': 'embedded'}, {**row, 'mcpRootId': 'different'}]
            with patch.object(root, 'read', wraps=root.read) as read:
                check_root_sources({'sources': rows}, root)
            self.assertEqual(read.call_count, 2)
            self.assertEqual([r['status'] for r in rows], ['unchanged', 'changed', 'missing', 'embedded', 'unavailable'])
            self.assertEqual(rows[1]['currentFingerprint'], digest)
            self.assertEqual(rows[1]['usedBy'], row['usedBy'])
            self.assertNotIn('mcpRootId', rows[0])
            allowed.rename(base / 'old')
            allowed.mkdir()
            (allowed / 'file.svg').write_bytes(b'<svg/>')
            self.assertNotEqual(AssetRoot(allowed).id, root.id)
            with self.assertRaisesRegex(ValueError, 'replaced'):
                root.import_files(['file.svg'])

    def test_import_requires_configured_root_and_checks_total_read_size_before_delivery(self):
        local = {'app': 'figure-editor-local', 'automation': True, 'token': 't'}
        with tempfile.TemporaryDirectory() as directory:
            client = EditorClient(1, directory)
            args = {'sessionId': 's', 'expectedRevision': '1:0', 'paths': ['a.svg', 'b.svg']}
            with patch.object(client, 'request', return_value=local) as request, self.assertRaisesRegex(ValueError, '--asset-root'):
                client.call('figure_import_assets', args)
            self.assertFalse(any(call.args[0].endswith('/command') for call in request.call_args_list))
            client = EditorClient(1, directory, directory)
            for name in args['paths']:
                Path(directory, name).write_bytes(b'<svg/>')
            with patch('figure_mcp.MAX_IMPORT_BYTES', 10), patch.object(client, 'request', return_value=local) as request:
                with self.assertRaisesRegex(ValueError, 'remaining read budget'):
                    client.call('figure_import_assets', args)
            self.assertFalse(any(call.args[0].endswith('/command') for call in request.call_args_list))

    def test_atomic_source_replacement_during_hash_does_not_report_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            root = AssetRoot(directory)
            original = Path(directory, 'plot.svg')
            original.write_bytes(b'<svg/>')
            replacement = Path(directory, 'next.svg')
            replacement.write_bytes(b'<svg><g/></svg>')
            report = {'sources': [{'assetId': 'a', 'status': 'check_root', 'relativePath': 'plot.svg',
                                   'mcpRootId': root.id, 'fingerprint': hashlib.sha256(b'<svg/>').hexdigest()}]}
            real_stat = os.stat
            def replace_at_verification(path, *args, **kwargs):
                if path == 'plot.svg' and 'dir_fd' in kwargs:
                    os.replace(replacement, original)
                return real_stat(path, *args, **kwargs)
            with patch('figure_mcp.os.stat', side_effect=replace_at_verification):
                check_root_sources(report, root)
            self.assertEqual(report['sources'][0]['status'], 'unavailable')
            self.assertIn('changed while being read', report['sources'][0]['reason'])


class MCPTests(unittest.TestCase):
    def test_invalid_protocol_version_does_not_crash_the_server(self):
        instance = MCPServer(None)
        for version in ([], {}, None):
            result = instance.dispatch({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': version}})
            self.assertEqual(result['error']['code'], -32602)
        self.assertEqual(instance.dispatch({'jsonrpc': '2.0', 'id': 2, 'method': 'ping'})['result'], {})

    def test_stdio_handshake_notifications_errors_and_tool_discovery(self):
        messages = [{'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-11-25'}},
                    {'jsonrpc': '2.0', 'method': 'notifications/initialized'},
                    {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'},
                    {'jsonrpc': '2.0', 'id': 3, 'method': 'not-supported'}]
        result = subprocess.run([sys.executable, str(Path(__file__).resolve().parents[1] / 'figure_mcp.py')],
                                input='\n'.join(json.dumps(m) for m in messages) + '\n{broken\n', text=True, capture_output=True, check=True)
        replies = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual(len(replies), 4)
        self.assertEqual(replies[0]['result']['protocolVersion'], '2025-11-25')
        tools = {tool['name']: tool for tool in replies[1]['result']['tools']}
        self.assertEqual(len(tools), 13)
        self.assertTrue(tools['figure_inspect_svg']['annotations']['readOnlyHint'])
        self.assertTrue(tools['figure_check_sources']['annotations']['readOnlyHint'])
        self.assertFalse(tools['figure_import_assets']['annotations']['readOnlyHint'])
        self.assertEqual(set(tools), {'figure_sessions'} | {'figure_' + method for method in METHODS})
        self.assertTrue(tools['figure_preview_batch']['annotations']['readOnlyHint'])
        self.assertTrue(tools['figure_check_export']['annotations']['readOnlyHint'])
        self.assertFalse(tools['figure_duplicate_slide']['annotations']['readOnlyHint'])
        self.assertEqual(replies[2]['error']['code'], -32601)
        self.assertEqual(replies[3]['error']['code'], -32700)
        self.assertEqual(result.stderr, '')

    def test_tools_validate_before_network_and_do_not_accept_paths_or_code(self):
        client = EditorClient(1, '/tmp/unused')
        for name, args in [('figure_export', {'sessionId': 's', 'format': 'png', 'path': '/tmp/escape'}),
                           ('figure_history', {'sessionId': 's', 'action': 'undo'}),
                           ('figure_batch_edit', {'sessionId': 's', 'expectedRevision': '1:0', 'operations': [{'op': 'eval', 'script': 'bad'}]})]:
            with self.assertRaises(ValueError), patch.object(client, 'request', side_effect=AssertionError('must not connect')):
                client.call(name, args)

    def test_place_asset_accepts_project_asset_id_and_optional_placement(self):
        schema = next(tool['inputSchema'] for tool in TOOLS if tool['name'] == 'figure_batch_edit')
        place = {'op': 'place_asset', 'slideId': 'slide', 'assetId': 'asset'}
        batch = {'sessionId': 's', 'expectedRevision': '1:0'}
        validate({**batch, 'operations': [
            place,
            {**place, 'properties': {'width': 120}},
            {**place, 'properties': {'name': 'Panel A', 'x': 10, 'y': 20, 'width': 240,
                                     'height': 100, 'rotation': 10, 'opacity': .8}},
        ]}, schema)
        for invalid in ({'op': 'place_asset', 'slideId': 'slide'},
                        {**place, 'assetId': ''}, {**place, 'path': '/tmp/figure.svg'},
                        {**place, 'dataUrl': 'data:image/svg+xml;base64,PHN2Zy8+'},
                        {**place, 'properties': {'text': 'label'}},
                        {**place, 'properties': {'width': '120px'}}):
            with self.subTest(operation=invalid), self.assertRaises(ValueError):
                validate({**batch, 'operations': [invalid]}, schema)

    def test_object_svg_and_preserved_crop_operations_validate_before_network(self):
        schemas = {tool['name']: tool['inputSchema'] for tool in TOOLS}
        batch = {'sessionId': 's', 'expectedRevision': '1:0'}
        target = {'slideId': 'slide', 'itemIds': ['a', 'b']}
        operations = [
            {'op': 'duplicate', **target, 'offsetX': -20, 'offsetY': 0},
            {'op': 'delete', **target}, {'op': 'reorder', **target, 'direction': 'backward'},
            {'op': 'set_hidden', **target, 'hidden': True}, {'op': 'set_locked', **target, 'locked': False},
            {'op': 'replace_asset', **target, 'assetId': 'new'},
            {'op': 'edit_svg', 'slideId': 'slide', 'itemId': 'a', 'assetId': 'old', 'patches': [
                {'path': [1, 2], 'attributes': {'font-size': '16', 'fill': '#123456'}},
                {'path': [1], 'textIndex': 0, 'text': 'μ(E)'},
                {'path': [1], 'attributes': {'font-family': 'Arial'}, 'textIndex': 0, 'text': ''},
            ]},
        ]
        validate({**batch, 'operations': operations}, schemas['figure_batch_edit'])
        inspect = {'sessionId': 's', 'slideId': 'slide', 'itemId': 'a', 'limit': 100, 'offset': 0}
        validate(inspect, schemas['figure_inspect_svg'])
        client = EditorClient(1, '/tmp/unused')
        bad = [
            {'op': 'set_locked', **target, 'locked': 0}, {'op': 'set_hidden', **target, 'hidden': 'true'},
            {'op': 'reorder', **target, 'direction': 'up'}, {'op': 'replace_asset', **target},
            {'op': 'duplicate', **target, 'offsetX': True},
        ]
        svg = operations[-1]
        for svg_patch in [{'path': []}, {'path': [], 'attributes': {}},
                      {'path': [True], 'attributes': {'fill': 'red'}},
                      {'path': [-1], 'attributes': {'fill': 'red'}},
                      {'path': [], 'attributes': {'href': 'https://example.com'}},
                      {'path': [], 'attributes': {'style': 'fill:red'}},
                      {'path': [], 'text': 'missing index'}, {'path': [], 'textIndex': 0},
                      {'path': [], 'textIndex': 0, 'text': 'x' * 20001}]:
            bad.append({**svg, 'patches': [svg_patch]})
        for operation in bad:
            with self.subTest(operation=operation), self.assertRaises(ValueError), patch.object(client, 'request', side_effect=AssertionError('must not connect')):
                client.call('figure_batch_edit', {**batch, 'operations': [operation]})
        for overrides in [{'limit': 101}, {'offset': -1}, {'offset': False}, {'script': 'bad'}]:
            with self.assertRaises(ValueError), patch.object(client, 'request', side_effect=AssertionError('must not connect')):
                client.call('figure_inspect_svg', {**inspect, **overrides})

    def test_exports_write_new_files_only_and_report_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            client = EditorClient(1, directory)
            value = {'data': base64.b64encode(b'<svg/>').decode(), 'mimeType': 'image/svg+xml', 'renderedRevision': '1:0'}
            with patch.object(client, 'request', side_effect=lambda path, *args: {'app': 'figure-editor-local', 'automation': True, 'token': 'test'} if path == '/api/local' else value):
                first = client.call('figure_export', {'sessionId': 's', 'format': 'svg'})['structuredContent']
                second = client.call('figure_export', {'sessionId': 's', 'format': 'svg'})['structuredContent']
            self.assertNotEqual(first['path'], second['path'])
            self.assertEqual(Path(first['path']).read_bytes(), b'<svg/>')
            self.assertEqual(len(first['sha256']), 64)
            self.assertNotIn('data', first)

    def test_swap_asset_requires_single_item_and_replacement_asset_ids(self):
        schema = next(tool['inputSchema'] for tool in TOOLS if tool['name'] == 'figure_batch_edit')
        swap = {'op': 'swap_asset', 'slideId': 'slide', 'itemId': 'panel', 'assetId': 'replacement'}
        batch = {'sessionId': 's', 'expectedRevision': '1:0'}
        validate({**batch, 'operations': [swap]}, schema)
        invalid = [
            {key: value for key, value in swap.items() if key != field}
            for field in ('slideId', 'itemId', 'assetId')
        ]
        invalid.extend([{**swap, 'assetId': ''}, {**swap, 'itemId': ['panel']},
                        {**swap, 'itemIds': ['panel']}, {**swap, 'properties': {'width': 100}},
                        {**swap, 'path': '/tmp/replacement.svg'}, {**swap, 'dataUrl': 'data:image/png;base64,...'}])
        for operation in invalid:
            with self.subTest(operation=operation), self.assertRaises(ValueError):
                validate({**batch, 'operations': [operation]}, schema)

    def test_export_check_and_duplicate_slide_arguments(self):
        schemas = {tool['name']: tool['inputSchema'] for tool in TOOLS}
        check = schemas['figure_check_export']
        args = {'sessionId': 's', 'format': 'pptx'}
        validate(args, check)
        validate({**args, 'slideId': 'slide', 'finalWidthMm': 85.5, 'minRasterDpi': .5}, check)
        for key in ('finalWidthMm', 'minRasterDpi'):
            for value in (0, -1, True, '300', float('inf'), float('nan'), 10**400):
                with self.subTest(field=key, value=value), self.assertRaises(ValueError):
                    validate({**args, key: value}, check)
        with self.assertRaises(ValueError):
            validate({**args, 'format': 'jpeg'}, check)
        duplicate = schemas['figure_duplicate_slide']
        args = {'sessionId': 's', 'expectedRevision': '1:0', 'slideId': 'slide'}
        validate(args, duplicate)
        validate({**args, 'name': '新' * 300}, duplicate)
        for invalid in [{k: v for k, v in args.items() if k != 'expectedRevision'},
                        {k: v for k, v in args.items() if k != 'slideId'},
                        {**args, 'name': ' \t'}, {**args, 'name': 'x' * 301}]:
            with self.subTest(operation=invalid), self.assertRaises(ValueError):
                validate(invalid, duplicate)

    def test_preview_batch_returns_proposed_png_and_never_writes_an_export(self):
        operation = {'op': 'place_asset', 'slideId': 'slide', 'assetId': 'plot'}
        args = {'sessionId': 's', 'expectedRevision': '1:0', 'operations': [operation], 'maxSize': 256}
        schema = next(tool['inputSchema'] for tool in TOOLS if tool['name'] == 'figure_preview_batch')
        validate({**args, 'operations': [operation] * 200, 'maxSize': 1600}, schema)
        for invalid in [{**args, 'operations': []}, {**args, 'operations': [operation] * 201},
                        {**args, 'operations': [{'op': 'replace_document'}]}, {**args, 'maxSize': 255},
                        {**args, 'maxSize': 1601}, {k: v for k, v in args.items() if k != 'expectedRevision'}]:
            with self.subTest(fields=invalid.keys()), self.assertRaises(ValueError):
                validate(invalid, schema)
        encoded = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII='
        preview = {'mimeType': 'image/png', 'proposed': True, 'data': encoded}
        local = {'app': 'figure-editor-local', 'automation': True, 'token': 'test'}
        with tempfile.TemporaryDirectory() as directory:
            client = EditorClient(1, directory)
            with patch.object(client, 'request', side_effect=[local, preview]) as request:
                result = client.call('figure_preview_batch', args)
            request.assert_called_with('/api/automation/command', {'sessionId': 's', 'method': 'preview_batch',
                                       'params': {k: v for k, v in args.items() if k != 'sessionId'}}, 'test')
            self.assertEqual(result['structuredContent'], {'mimeType': 'image/png', 'proposed': True})
            self.assertEqual(result['content'][1], {'type': 'image', 'mimeType': 'image/png', 'data': encoded})
            self.assertEqual(list(Path(directory).iterdir()), [])
            with patch.object(client, 'request', side_effect=[local, {**preview, 'proposed': False}]), self.assertRaisesRegex(ValueError, 'proposal'):
                client.call('figure_preview_batch', args)


if __name__ == '__main__':
    unittest.main()
