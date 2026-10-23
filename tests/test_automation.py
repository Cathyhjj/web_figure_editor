"""Local bridge and MCP transport regression tests; synthetic sessions only."""
import base64
from concurrent.futures import ThreadPoolExecutor
import http.client
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from automation_bridge import AutomationBridge, AutomationError
from figure_mcp import EditorClient, MCPServer, TOOLS, validate
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
        self.assertEqual(len(replies[1]['result']['tools']), 7)
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


if __name__ == '__main__':
    unittest.main()
