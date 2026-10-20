"""Finder bridge tests; no test opens Finder or a native file picker."""

import ast
import hashlib
import http.client
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


class LocalServerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        (self.root / "index.html").write_text("Figure Editor", encoding="utf-8")
        (self.root / "tests").mkdir()
        (self.root / "tests" / "browser.html").write_text("Browser tests", encoding="utf-8")
        self.image = self.root / "examples" / "panel.png"
        self.image.parent.mkdir()
        self.image.write_bytes(b"test image contents")
        self.asset = {"id": "asset-1", "name": "panel.png", "relativePath": "examples/panel.png",
                      "fingerprint": "sha256:" + hashlib.sha256(self.image.read_bytes()).hexdigest()}
        self.local = server.create_server(self.root, 0)
        self.thread = threading.Thread(target=self.local.serve_forever, daemon=True)
        self.thread.start()
        self.origin = "http://127.0.0.1:" + str(self.local.server_port)
        self.platform = mock.patch.object(server.sys, "platform", "darwin")
        self.platform.start()
        self.native = mock.patch.object(server.subprocess, "run")
        self.run = self.native.start()
        self.run.return_value = subprocess.CompletedProcess([], 0, stdout="", stderr="")
        self.discovery = mock.patch.object(server.Locator, "indexed_sources", return_value=[])
        self.discover = self.discovery.start()
        self.quiet = mock.patch.object(server.Handler, "log_message")
        self.quiet.start()

    def tearDown(self):
        self.local.shutdown()
        self.thread.join()
        self.local.server_close()
        self.quiet.stop()
        self.native.stop()
        self.discovery.stop()
        self.platform.stop()
        self.temporary.cleanup()

    def request(self, method="GET", path="/api/local", data=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.local.server_port, timeout=3)
        body = json.dumps(data) if data is not None else None
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        status, raw = response.status, response.read()
        connection.close()
        return status, raw

    def locate(self, asset=None, **changes):
        headers = {"Origin": self.origin, "Content-Type": "application/json", "X-Figure-Token": self.local.token}
        headers.update(changes)
        return self.request("POST", "/api/locate", {"asset": self.asset if asset is None else asset}, headers)

    def test_capability_and_regular_static_content(self):
        status, raw = self.request()
        data = json.loads(raw)
        self.assertEqual(status, 200)
        self.assertEqual(data, {"app": "figure-editor-local", "version": 1, "locate": True,
                            "pdfTextOutlines": False, "pptxImport": True, "token": self.local.token})
        self.assertEqual(self.request(path="/")[1], b"Figure Editor")
        self.assertEqual(self.request(path="/tests/browser.html")[1], b"Browser tests")
        self.assertEqual(self.request(path="/examples/panel.png")[1], self.image.read_bytes())
        self.run.assert_not_called()

    def test_verified_relative_image_uses_exact_open_argv(self):
        status, raw = self.locate()
        self.assertEqual((status, json.loads(raw)), (200, {"status": "revealed"}))
        self.run.assert_called_once_with(["/usr/bin/open", "-R", str(self.image.resolve())],
                                         capture_output=True, check=True, timeout=10)

    def test_bare_fingerprint_is_supported(self):
        asset = {**self.asset, "fingerprint": self.asset["fingerprint"].removeprefix("sha256:")}
        self.assertEqual(self.locate(asset)[0], 200)
        self.assertEqual(self.run.call_args.args[0][0], "/usr/bin/open")

    def test_host_origin_and_token_denials_have_no_side_effects(self):
        for header in ({"Origin": "https://evil.example"}, {"Host": "evil.example"},
                       {"Origin": "null"}, {"X-Figure-Token": "wrong"}, {"X-Figure-Token": "é"},
                       {"Sec-Fetch-Site": "cross-site"}):
            with self.subTest(header=header):
                self.assertEqual(self.locate(**header)[0], 403)
        self.assertEqual(self.request("POST", "/api/locate", {"asset": self.asset},
                                     {"Content-Type": "application/json", "X-Figure-Token": self.local.token})[0], 403)
        self.assertEqual(self.request(headers={"Host": "evil.example"})[0], 403)
        self.assertEqual(self.request(headers={"Origin": "https://evil.example"})[0], 403)
        self.run.assert_not_called()

    def test_unsafe_relative_paths_never_open_anything(self):
        for path in ("../panel.png", "/tmp/panel.png", "C:\\panel.png", "examples/../../panel.png", ".git/panel.png"):
            with self.subTest(path=path):
                self.assertEqual(self.locate({**self.asset, "relativePath": path})[0], 400)
        outside = self.root.parent / (self.root.name + "-outside.png")
        outside.write_bytes(self.image.read_bytes())
        try:
            (self.root / "escape.png").symlink_to(outside)
            self.assertEqual(self.locate({**self.asset, "relativePath": "escape.png"})[0], 400)
            self.assertEqual(self.request(path="/escape.png")[0], 403)
        finally:
            outside.unlink()
        self.run.assert_not_called()

    def test_hidden_files_and_directory_listings_are_not_served(self):
        (self.root / ".private.json").write_text("private", encoding="utf-8")
        (self.root / "alias.json").symlink_to(self.root / ".private.json")
        for path in ("/.local-locations.json", "/%2Elocal-locations.json", "/.git/config", "/examples/../.local-locations.json"):
            with self.subTest(path=path):
                self.assertEqual(self.request(path=path)[0], 403)
        self.assertEqual(self.request(path="/examples/")[0], 403)
        self.assertEqual(self.request(path="/alias.json")[0], 403)

    def test_missing_foreign_or_mismatched_sources_fail_without_native_picker(self):
        for change in ({"relativePath": "foreign/panel.png"}, {"fingerprint": "0" * 64}):
            with self.subTest(change=change):
                self.run.reset_mock()
                status, raw = self.locate({**self.asset, **change})
                self.assertEqual(status, 404)
                self.assertIn("error", json.loads(raw))
                self.run.assert_not_called()
        self.run.reset_mock()
        self.assertEqual(self.locate({"id": "no-path", "name": "panel.png"})[0], 404)
        self.run.assert_not_called()

    def test_discovered_image_is_revealed_and_persisted_without_path_response(self):
        asset = {"id": "outside", "name": 'image "; do shell script "bad.png', "linkToken": "link-1"}
        self.discover.return_value = [self.image.resolve()]
        status, raw = self.locate(asset)
        self.assertEqual((status, json.loads(raw)), (200, {"status": "revealed"}))
        self.run.assert_called_once_with(["/usr/bin/open", "-R", str(self.image.resolve())],
                                         capture_output=True, check=True, timeout=10)
        self.assertNotIn(str(self.root).encode(), raw)
        self.assertTrue((self.root / ".local-locations.json").is_file())
        self.assertEqual((self.root / ".local-locations.json").stat().st_mode & 0o777, 0o600)
        self.local.locator = server.Locator(self.root)
        self.run.reset_mock()
        self.discover.return_value = []
        self.assertEqual(self.locate(asset)[0], 200)
        self.run.assert_called_once()
        self.assertEqual(self.run.call_args.args[0][0], "/usr/bin/open")
        self.run.reset_mock()
        self.assertEqual(self.locate({**asset, "linkToken": "link-2"})[0], 404)
        self.run.assert_not_called()
        self.image.unlink()
        self.run.reset_mock()
        self.assertEqual(self.locate(asset)[0], 404)
        self.run.assert_not_called()

    def test_missing_and_ambiguous_sources_return_errors_without_native_dialog(self):
        asset = {"id": "unknown", "name": "unknown.png"}
        self.assertEqual(self.locate(asset)[0], 404)
        second = self.root / "unknown.png"
        second.write_bytes(b"second image")
        self.discover.return_value = [self.image.resolve(), second.resolve()]
        self.assertEqual(self.locate(asset)[0], 409)
        self.run.assert_not_called()

    def test_oversized_unindexed_source_is_not_automatically_hashed_or_revealed(self):
        with self.image.open("wb") as stream:
            stream.truncate(server.MAX_SOURCE_BYTES + 1)
        self.assertEqual(self.locate()[0], 404)
        self.run.assert_not_called()

    def test_busy_unsupported_and_native_failure(self):
        self.local.locator.lock.acquire()
        try:
            self.assertEqual(self.locate()[0], 409)
        finally:
            self.local.locator.lock.release()
        with mock.patch.object(server.sys, "platform", "linux"):
            self.assertFalse(json.loads(self.request()[1])["locate"])
            self.assertEqual(self.locate()[0], 501)
        self.run.assert_not_called()
        self.run.side_effect = subprocess.CalledProcessError(1, "open", stderr="private path")
        status, raw = self.locate()
        self.assertEqual(status, 500)
        self.assertNotIn(b"private path", raw)

    def test_malformed_or_oversized_request_is_rejected(self):
        self.assertEqual(self.locate({"name": "panel.png"})[0], 400)
        self.assertEqual(self.locate({**self.asset, "fingerprint": "wrong"})[0], 400)
        self.assertEqual(self.locate({**self.asset, "name": "x" * server.MAX_BODY})[0], 413)
        self.assertEqual(self.locate(**{"Content-Type": "text/plain"})[0], 400)
        self.assertEqual(self.locate(**{"Content-Length": "9" * 5000})[0], 413)
        self.run.assert_not_called()


class StartupCapabilityTests(unittest.TestCase):
    def test_existing_backend_requires_current_local_capabilities(self):
        source = (Path(__file__).resolve().parents[1] / "start.command").read_text().split("<<'PY'\n", 1)[1].rsplit("\nPY", 1)[0]
        check = next(node for node in ast.parse(source).body
                     if isinstance(node, ast.FunctionDef) and node.name == "has_local_backend")
        import urllib.error
        import urllib.request
        opener = mock.Mock()
        # A context manager response, without launching the startup script or any server.
        opener.open.return_value = mock.MagicMock()
        response = opener.open.return_value.__enter__.return_value
        response.status = 200
        namespace = {"urllib": urllib, "opener": opener, "json": json, "url": "http://127.0.0.1:8766/"}
        exec(compile(ast.Module(body=[check], type_ignores=[]), "start.command", "exec"), namespace)
        identity = {"app": "figure-editor-local", "version": 1, "locate": True, "token": "test", "pptxImport": True}
        for name in ("pptxImport",):
            for capability, expected in ((None, False), (False, False), ("true", False), (True, True)):
                with self.subTest(name=name,capability=capability):
                    response.read.return_value = json.dumps({**identity, name: capability}).encode()
                    self.assertEqual(namespace["has_local_backend"](), expected)


if __name__ == "__main__":
    unittest.main()
