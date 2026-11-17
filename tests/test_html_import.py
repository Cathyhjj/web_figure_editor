"""Archive limits and the authenticated HTML renderer API, without user files."""
import base64
import http.client
import io
import json
from pathlib import Path
import stat
import sys
import tempfile
import threading
import unittest
from unittest import mock
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from html_import import read_package, HTMLImportError, MAX_HTML_BODY
import server


def payload(source=b'<!doctype html><figure>Example</figure>', name='figure.html'):
    return {'name': name, 'data': base64.b64encode(source).decode()}


def archive(entries):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w') as z:
        for name, data in entries:
            z.writestr(name, data)
    return payload(stream.getvalue(), 'figures.zip')


class HTMLPackageTests(unittest.TestCase):
    def test_html_and_nested_zip_preserve_exact_source_and_dependencies(self):
        original = '<!doctype html><figure>Cu–O</figure>'.encode()
        result = read_package(payload(original))
        self.assertEqual(base64.b64decode(result['files']['figure.html']['data']), original)
        package = read_package(archive([('nested/page.html', original), ('nested/style.css', b'figure{color:red}'), ('sources/data.csv', b'x,y\n1,2')]))
        self.assertEqual(package['documents'], ['nested/page.html'])
        self.assertEqual(package['source']['mime'], 'application/zip')
        self.assertIn('nested/style.css', package['files'])

    def test_traversal_absolute_duplicate_symlink_and_invalid_archives_rejected(self):
        for name in ['../figure.html', '/figure.html', 'C:/figure.html', 'dir/../figure.html', 'dir\\figure.html']:
            with self.subTest(name=name), self.assertRaises(HTMLImportError):
                read_package(archive([(name, b'<html>bad</html>')]))
        with self.assertRaises(HTMLImportError):
            read_package(archive([('a.html', b'<html>a</html>'), ('a.html', b'<html>b</html>')]))
        link = zipfile.ZipInfo('a.html'); link.external_attr = (stat.S_IFLNK | 0o777) << 16
        with self.assertRaises(HTMLImportError):
            read_package(archive([(link, b'/etc/passwd')]))
        for value in [payload(b'not a ZIP', 'a.zip'), payload(b'not HTML'), payload(b'<html>\xff'), {'name': 'x.html', 'data': '%%%%'}]:
            with self.assertRaises(HTMLImportError):
                read_package(value)

    def test_archive_limits_and_target_validation(self):
        with self.assertRaises(HTMLImportError):
            read_package(archive([(f'{i}.html', b'<html>x</html>') for i in range(33)]))
        with self.assertRaises(HTMLImportError):
            read_package(archive([(f'{i}.txt', b'') for i in range(513)]))
        for setting in [{'width': 0}, {'width': True}, {'dpi': 96}, {'dpi': []}, {'dpi': {}}, {'frozen': 1}, {'frozen': True}, {'target': {'page': 'x', 'figure': -2}}, {'target': {'page': 'x', 'figure': True}}, {'path': '/etc/passwd'}]:
            with self.subTest(setting=setting), self.assertRaises(HTMLImportError):
                read_package({**payload(), **setting})

    def test_edited_html_accepts_only_an_explicit_single_document_target(self):
        result = read_package({**payload(), 'frozen': True, 'target': {'page': 'figure.html', 'figure': -1}})
        self.assertTrue(result['frozen'])
        with self.assertRaises(HTMLImportError):
            read_package({**archive([('a.html', b'<html></html>')]), 'frozen': True, 'target': {'page': 'a.html', 'figure': -1}})


class HTMLApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        cls.local = server.create_server(Path(cls.directory.name), 0)
        cls.thread = threading.Thread(target=cls.local.serve_forever, daemon=True); cls.thread.start()
        cls.origin = f'http://127.0.0.1:{cls.local.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.local.shutdown(); cls.local.server_close(); cls.thread.join(); cls.directory.cleanup()

    def request(self, changes=None):
        body = json.dumps(payload()).encode()
        headers = {'Origin': self.origin, 'Content-Type': 'application/json', 'X-Figure-Token': self.local.token, 'Content-Length': str(len(body))}
        for key, value in (changes or {}).items():
            if value is None: headers.pop(key, None)
            else: headers[key] = value
        conn = http.client.HTTPConnection('127.0.0.1', self.local.server_port, timeout=5)
        with mock.patch.object(server.Handler, 'log_message'):
            conn.request('POST', '/api/html-import', body, headers)
            response = conn.getresponse(); result = response.status, json.loads(response.read())
        conn.close(); return result

    def test_origin_token_and_size_gate_precede_renderer(self):
        with mock.patch.object(server, 'import_html') as render:
            for changes in [{'Origin': None}, {'Origin': 'https://foreign.example'}, {'X-Figure-Token': 'invalid'}, {'Sec-Fetch-Site': 'cross-site'}]:
                self.assertEqual(self.request(changes)[0], 403)
            self.assertEqual(self.request({'Content-Length': str(MAX_HTML_BODY + 1)})[0], 413)
            self.assertEqual(self.request({'Content-Type': 'text/plain'})[0], 400)
            render.assert_not_called()

    def test_success_and_typed_failure_return_json(self):
        with mock.patch.object(server, 'import_html', return_value={'candidates': []}) as render:
            self.assertEqual(self.request(), (200, {'candidates': []})); render.assert_called_once()
        with mock.patch.object(server, 'import_html', side_effect=HTMLImportError(422, 'Unreadable HTML')):
            self.assertEqual(self.request(), (422, {'error': 'Unreadable HTML'}))


if __name__ == '__main__': unittest.main()
