"""Finder bridge tests; no test opens Finder or a native file picker."""

import ast
import base64
import errno
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


PNG_BYTES = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=")


def image_payload(data=PNG_BYTES, mime="image/png"):
    return {"dataUrl": "data:" + mime + ";base64," + base64.b64encode(data).decode("ascii")}


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
        # Discovery has separate tests; these API checks never query the real index.
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

    def save_clipboard(self, data=None, **changes):
        headers = {"Origin": self.origin, "Content-Type": "application/json", "X-Figure-Token": self.local.token}
        headers.update(changes)
        return self.request("POST", "/api/clipboard-image", image_payload() if data is None else data, headers)

    def test_capability_and_regular_static_content(self):
        status, raw = self.request()
        data = json.loads(raw)
        self.assertEqual(status, 200)
        self.assertEqual(data, {"app": "figure-editor-local", "version": 1, "locate": True,
                            "saveClipboardImage": True, "pdfTextOutlines": False, "pptxImport": True, "pptxPaste": True,
                            "pptxClipboard": server.clipboard_available(), "pptxClipboardReady": server.clipboard_ready(),
                            "automation": True, "token": self.local.token})
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

    def test_linked_location_survives_refresh_and_keeps_relink_and_undo_separate(self):
        asset = {"id": "linked", "name": "panel.png", "linkToken": "original-link",
                 "fingerprint": hashlib.sha256(self.image.read_bytes()).hexdigest()}
        self.discover.return_value = [self.image.resolve()]
        self.assertEqual(self.locate(asset)[0], 200)
        self.image.write_bytes(b"updated original image")
        refreshed = {**asset, "fingerprint": hashlib.sha256(self.image.read_bytes()).hexdigest()}
        self.local.locator = server.Locator(self.root)
        self.run.reset_mock()
        self.discover.return_value = []
        self.assertEqual(self.locate(refreshed)[0], 200)
        self.run.assert_called_once_with(["/usr/bin/open", "-R", str(self.image.resolve())],
                                         capture_output=True, check=True, timeout=10)

        replacement = self.root / "replacement.png"
        replacement.write_bytes(b"different linked image")
        relinked = {**refreshed, "linkToken": "replacement-link"}
        self.run.reset_mock()
        self.discover.return_value = [replacement.resolve()]
        self.assertEqual(self.locate(relinked)[0], 200)
        self.run.assert_called_once_with(["/usr/bin/open", "-R", str(replacement.resolve())],
                                         capture_output=True, check=True, timeout=10)

        self.local.locator = server.Locator(self.root)
        self.discover.return_value = []
        for restored, path in ((asset, self.image), (relinked, replacement)):
            with self.subTest(link_token=restored["linkToken"]):
                self.run.reset_mock()
                self.assertEqual(self.locate(restored)[0], 200)
                self.run.assert_called_once_with(["/usr/bin/open", "-R", str(path.resolve())],
                                                 capture_output=True, check=True, timeout=10)

    def test_legacy_linked_location_migrates_before_later_refresh(self):
        asset = {"id": "legacy", "name": "panel.png", "linkToken": "legacy-link",
                 "fingerprint": hashlib.sha256(self.image.read_bytes()).hexdigest()}
        legacy_key = hashlib.sha256(json.dumps(asset, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        self.local.locator.remember(legacy_key, self.image)
        self.local.locator = server.Locator(self.root)
        self.assertEqual(self.locate(asset)[0], 200)
        self.run.assert_called_once_with(["/usr/bin/open", "-R", str(self.image.resolve())],
                                         capture_output=True, check=True, timeout=10)

        self.local.locator = server.Locator(self.root)
        self.image.write_bytes(b"refreshed legacy image")
        self.run.reset_mock()
        refreshed = {**asset, "fingerprint": hashlib.sha256(self.image.read_bytes()).hexdigest()}
        self.assertEqual(self.locate(refreshed)[0], 200)
        self.run.assert_called_once_with(["/usr/bin/open", "-R", str(self.image.resolve())],
                                         capture_output=True, check=True, timeout=10)

    def test_copy_location_remains_bound_to_its_complete_source_metadata(self):
        asset = {"id": "copy", "name": "panel.png",
                 "fingerprint": hashlib.sha256(self.image.read_bytes()).hexdigest()}
        self.discover.return_value = [self.image.resolve()]
        self.assertEqual(self.locate(asset)[0], 200)
        self.local.locator = server.Locator(self.root)
        self.run.reset_mock()
        self.discover.return_value = []
        self.assertEqual(self.locate({**asset, "fingerprint": "0" * 64})[0], 404)
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


    def test_clipboard_save_preserves_bytes_deduplicates_and_locates_without_picker(self):
        status, raw = self.save_clipboard()
        digest = hashlib.sha256(PNG_BYTES).hexdigest()
        saved = json.loads(raw)
        self.assertEqual((status, saved), (200, {"relativePath": "local-assets/pasted/" + digest + ".png",
                                                "fingerprint": digest}))
        path = self.root / saved["relativePath"]
        self.assertEqual(path.read_bytes(), PNG_BYTES)
        metadata = path.stat()
        self.assertEqual(metadata.st_mode & 0o777, 0o600)
        self.assertEqual(self.save_clipboard(), (status, raw))
        self.assertEqual((path.stat().st_ino, path.stat().st_mtime_ns), (metadata.st_ino, metadata.st_mtime_ns))
        self.assertEqual(list(path.parent.iterdir()), [path])
        self.assertEqual(self.locate({"id": "clipboard", "name": "pasted image.png", **saved})[0], 200)
        self.run.assert_called_once_with(["/usr/bin/open", "-R", str(path.resolve())],
                                         capture_output=True, check=True, timeout=10)

    def test_clipboard_endpoint_enforces_origin_host_and_token_before_writing(self):
        for header in ({"Origin": "https://evil.example"}, {"Host": "evil.example"},
                       {"Origin": "null"}, {"X-Figure-Token": "wrong"}, {"X-Figure-Token": "é"},
                       {"Sec-Fetch-Site": "cross-site"}):
            with self.subTest(header=header):
                self.assertEqual(self.save_clipboard(**header)[0], 403)
        self.assertEqual(self.request("POST", "/api/clipboard-image", image_payload(),
                                     {"Content-Type": "application/json", "X-Figure-Token": self.local.token})[0], 403)
        self.assertFalse((self.root / "local-assets").exists())
        self.run.assert_not_called()

    def test_clipboard_endpoint_rejects_bad_requests_and_never_uses_caller_paths(self):
        for payload in ({}, [], {"dataUrl": 42}, {"dataUrl": "data:image/png;base64,broken!"},
                        {**image_payload(), "relativePath": "../../outside.png"},
                        {**image_payload(), "name": "../../outside.png"},
                        image_payload(b"not a png"), image_payload(b"", "image/png")):
            with self.subTest(payload=payload):
                self.assertEqual(self.save_clipboard(payload)[0], 400)
        self.assertEqual(self.save_clipboard(**{"Content-Type": "text/plain"})[0], 400)
        self.assertEqual(self.save_clipboard(**{"Transfer-Encoding": "chunked"})[0], 400)
        self.assertEqual(self.save_clipboard(**{"Content-Length": str(server.MAX_CLIPBOARD_BODY + 1)})[0], 413)
        self.assertEqual(self.save_clipboard(**{"Content-Length": "9" * 5000})[0], 413)
        self.assertFalse((self.root / "local-assets").exists())

    def test_clipboard_originals_are_not_served_directly_or_through_aliases(self):
        svg = b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
        status, raw = self.save_clipboard(image_payload(svg, "image/svg+xml"))
        self.assertEqual(status, 200)
        path = self.root / json.loads(raw)["relativePath"]
        self.assertEqual(path.read_bytes(), svg)
        (self.root / "alias.svg").symlink_to(path)
        (self.root / "assets-alias").symlink_to(path.parent, target_is_directory=True)
        for route in ("/" + json.loads(raw)["relativePath"], "/local-assets/", "/LOCAL-ASSETS/PASTED/" + path.name,
                      "/%6cocal-assets/pasted/" + path.name,
                      "/alias.svg", "/assets-alias/" + path.name):
            with self.subTest(route=route):
                self.assertEqual(self.request(path=route)[0], 403)
                self.assertEqual(self.request("HEAD", path=route)[0], 403)

    def test_clipboard_write_errors_are_reported_without_claiming_success(self):
        for action, failure in (("mkdir", PermissionError(errno.EACCES, "private source path")),
                                ("fsync", OSError(errno.ENOSPC, "private disk details")),
                                ("link", OSError(errno.EIO, "private disk details"))):
            with self.subTest(action=action), mock.patch.object(server.os, action, side_effect=failure):
                status, raw = self.save_clipboard()
                self.assertEqual(status, 500)
                self.assertIn(b"Could not save", raw)
                self.assertNotIn(b"private", raw)
        folder = self.root / "local-assets" / "pasted"
        self.assertEqual(list(folder.iterdir()), [])
        self.assertEqual(self.image.read_bytes(), b"test image contents")
        self.run.assert_not_called()


class ClipboardStorageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.store = server.ClipboardImages(self.root)

    def tearDown(self):
        self.temporary.cleanup()

    def assert_error(self, payload, status):
        with self.assertRaises(server.LocateError) as error:
            self.store.save(payload)
        self.assertEqual(error.exception.status, status)

    def test_supported_format_bytes_and_extensions(self):
        webp = b"RIFF" + (14).to_bytes(4, "little") + b"WEBPVP8L" + (2).to_bytes(4, "little") + b"\x2f\x00"
        svg = b'<?xml version="1.0"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>'
        for data, mime, extension in ((PNG_BYTES, "image/png", "png"), (b"\xff\xd8\xff\xe0image\xff\xd9", "image/jpeg", "jpg"),
                                      (webp, "image/webp", "webp"), (svg, "image/svg+xml", "svg")):
            with self.subTest(mime=mime):
                saved = self.store.save(image_payload(data, mime))
                path = self.root / saved["relativePath"]
                self.assertEqual(path.suffix, "." + extension)
                self.assertEqual(path.read_bytes(), data)
                self.assertEqual(saved["fingerprint"], hashlib.sha256(data).hexdigest())

    def test_invalid_format_base64_svg_roots_and_entities(self):
        for data, mime in ((PNG_BYTES, "image/jpeg"), (b"RIFF0000WEBP", "image/webp"),
                           (b"<html/>", "image/svg+xml"), (b'<svg xmlns="https://wrong.example"/>', "image/svg+xml"),
                           (b"<svg>", "image/svg+xml"), (b'<!DOCTYPE svg [<!ENTITY x "boom">]><svg>&x;</svg>', "image/svg+xml"),
                           (b"<svg/>", "text/html")):
            with self.subTest(data=data, mime=mime):
                self.assert_error(image_payload(data, mime), 400)
        for encoded in ("!!!!", "é", "a===", "aGVsbG8=\n", "aGVsbG8", ""):
            with self.subTest(encoded=encoded):
                self.assert_error({"dataUrl": "data:image/png;base64," + encoded}, 400)
        self.assertFalse((self.root / "local-assets").exists())

    def test_exact_raw_limit_and_oversize_are_enforced_before_write(self):
        # A small patched cap exercises base64 padding at the exact raw boundary.
        with mock.patch.object(server, "MAX_SOURCE_BYTES", len(PNG_BYTES)):
            saved = self.store.save(image_payload())
            self.assertEqual((self.root / saved["relativePath"]).read_bytes(), PNG_BYTES)
            self.assert_error(image_payload(PNG_BYTES + b"x"), 413)
            self.assert_error(image_payload(PNG_BYTES + b"xxxx"), 413)
        self.assertEqual(len(list((self.root / "local-assets" / "pasted").iterdir())), 1)

    def test_symlink_directories_and_non_directory_conflicts_are_rejected(self):
        with tempfile.TemporaryDirectory() as elsewhere:
            directory = self.root / "local-assets"
            directory.symlink_to(elsewhere, target_is_directory=True)
            self.assert_error(image_payload(), 409)
            self.assertEqual(list(Path(elsewhere).iterdir()), [])
            directory.unlink()
            directory.mkdir()
            pasted = directory / "pasted"
            pasted.symlink_to(elsewhere, target_is_directory=True)
            self.assert_error(image_payload(), 409)
            self.assertEqual(list(Path(elsewhere).iterdir()), [])
            pasted.unlink()
            pasted.write_bytes(b"keep this source")
            self.assert_error(image_payload(), 409)
            self.assertEqual(pasted.read_bytes(), b"keep this source")

    def test_existing_destination_conflicts_and_links_are_never_overwritten(self):
        folder = self.root / "local-assets" / "pasted"
        folder.mkdir(parents=True)
        path = folder / (hashlib.sha256(PNG_BYTES).hexdigest() + ".png")
        path.write_bytes(b"keep existing file")
        self.assert_error(image_payload(), 409)
        self.assertEqual(path.read_bytes(), b"keep existing file")
        path.unlink()
        outside = self.root / "outside.png"
        outside.write_bytes(PNG_BYTES)
        path.symlink_to(outside)
        self.assert_error(image_payload(), 409)
        self.assertTrue(path.is_symlink())
        self.assertEqual(outside.read_bytes(), PNG_BYTES)
        path.unlink()
        path.mkdir()
        self.assert_error(image_payload(), 409)
        self.assertTrue(path.is_dir())

    def test_concurrent_publication_deduplicates_without_temporary_files(self):
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=4) as pool:
            saved = list(pool.map(lambda _: self.store.save(image_payload()), range(8)))
        self.assertTrue(all(value == saved[0] for value in saved))
        path = self.root / saved[0]["relativePath"]
        self.assertEqual(list(path.parent.iterdir()), [path])
        self.assertEqual(path.read_bytes(), PNG_BYTES)


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
        identity = {"app": "figure-editor-local", "version": 1, "locate": True, "token": "test", "pptxImport": True, "pptxPaste": True, "saveClipboardImage": True}
        for name in ("pptxImport","pptxPaste","saveClipboardImage"):
            for capability, expected in ((None, False), (False, False), ("true", False), (True, True)):
                with self.subTest(name=name,capability=capability):
                    response.read.return_value = json.dumps({**identity, name: capability}).encode()
                    self.assertEqual(namespace["has_local_backend"](), expected)


if __name__ == "__main__":
    unittest.main()
