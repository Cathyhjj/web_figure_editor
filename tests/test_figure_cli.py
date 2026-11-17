import base64
from contextlib import redirect_stdout, redirect_stderr
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from figure_cli import main, compact_result, read_arguments
from figure_mcp import EditorClient, TOOLS, validate


class AuthoringTests(unittest.TestCase):
    def test_schema_supports_editable_authoring_and_rejects_invalid_fields_before_network(self):
        schema = next(t['inputSchema'] for t in TOOLS if t['name'] == 'figure_batch_edit')
        batch = {'sessionId': 's', 'expectedRevision': '1:0', 'operations': [
            {'op': 'add_slide', 'slideId': 'new-slide', 'name': 'Editable', 'canvas': {'width': 720, 'height': 360}},
            {'op': 'add_shape', 'slideId': 'new-slide', 'shapeType': 'arrow', 'properties': {'height': 0, 'stroke': '#123456'}},
            {'op': 'set_slide', 'slideId': 'new-slide', 'canvas': {'background': '#ffffff'}},
        ]}
        validate(batch, schema)
        client = EditorClient(1, '/tmp/unused')
        for op in [
            {'op': 'add_slide', 'slideId': '../bad'},
            {'op': 'add_shape', 'slideId': 's', 'shapeType': 'script'},
            {'op': 'set_slide', 'slideId': 's', 'canvas': {'width': 0}},
            {'op': 'add_shape', 'slideId': 's', 'shapeType': 'rect', 'properties': {'onclick': 'bad'}},
        ]:
            with self.subTest(op=op), self.assertRaises(ValueError), patch.object(client, 'request', side_effect=AssertionError('must not connect')):
                client.call('figure_batch_edit', {**batch, 'operations': [op]})

    def test_tools_are_discoverable_offline_and_unknown_tools_fail(self):
        output, errors = io.StringIO(), io.StringIO()
        with redirect_stdout(output), patch('figure_cli.EditorClient', side_effect=AssertionError('offline')):
            self.assertEqual(main(['tools', 'batch_edit']), 0)
        self.assertEqual(json.loads(output.getvalue())['tools'][0]['name'], 'figure_batch_edit')
        with redirect_stderr(errors):
            self.assertEqual(main(['tools', 'missing']), 1)
        self.assertFalse(json.loads(errors.getvalue())['ok'])

    def test_cli_forwards_exact_revision_once_and_reports_failures(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, 'arguments.json')
            args = {'sessionId': 's', 'expectedRevision': '3:7', 'destination': 'draft'}
            path.write_text(json.dumps(args))
            output = io.StringIO()
            with patch('figure_cli.EditorClient') as client, redirect_stdout(output):
                client.return_value.call.return_value = {'structuredContent': {'saved': True}, 'content': [], 'isError': False}
                self.assertEqual(main(['call', 'save', '--args', str(path)]), 0)
                client.return_value.call.assert_called_once_with('figure_save', args)
            self.assertTrue(json.loads(output.getvalue())['result']['saved'])
            errors = io.StringIO()
            with patch('figure_cli.EditorClient') as client, redirect_stderr(errors):
                client.return_value.call.side_effect = ValueError('Read state before retrying.')
                self.assertEqual(main(['call', 'save', '--args', str(path)]), 1)
                self.assertEqual(client.return_value.call.call_count, 1)
            self.assertIn('Read state', json.loads(errors.getvalue())['error'])

    def test_preview_files_are_unique_and_json_contains_no_base64(self):
        data = b'\x89PNG\r\n\x1a\nsynthetic'
        reply = {'structuredContent': {'renderedRevision': '1:2'}, 'content': [
            {'type': 'image', 'data': base64.b64encode(data).decode(), 'mimeType': 'image/png'}]}
        with tempfile.TemporaryDirectory() as directory:
            first = compact_result(reply, directory)
            second = compact_result(reply, directory)
            path = first['images'][0]['path']
            self.assertNotEqual(path, second['images'][0]['path'])
            self.assertEqual(Path(path).read_bytes(), data)
            self.assertNotIn(base64.b64encode(data).decode(), json.dumps(first))
            for value in ['[]', '{"x": NaN}', ' ' * (1024 * 1024 + 1)]:
                args = Path(directory, 'args.json'); args.write_text(value)
                with self.assertRaises(ValueError):
                    read_arguments(str(args))


if __name__ == '__main__':
    unittest.main()
