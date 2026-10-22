"""Desktop launcher integration tests, using a temporary checkout and port."""

import http.server
import importlib.util
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request


REPO = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("desktop_launcher", REPO / "scripts" / "desktop_launcher.py")
launcher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(launcher)


class DesktopLauncherTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        (self.root / "scripts").mkdir()
        shutil.copy2(REPO / "server.py", self.root / "server.py")
        shutil.copy2(REPO / "pdf_text.py", self.root / "pdf_text.py")
        shutil.copy2(REPO / "pptx_import.py", self.root / "pptx_import.py")
        shutil.copy2(REPO / "pptx_clipboard.py", self.root / "pptx_clipboard.py")
        shutil.copy2(REPO / "scripts" / "desktop_launcher.py", self.root / "scripts" / "desktop_launcher.py")
        (self.root / "index.html").write_text("live editor", encoding="utf-8")
        (self.root / "app.js").write_text("const live = 1;", encoding="utf-8")
        (self.root / "style.css").write_text("body {}", encoding="utf-8")
        with socket.socket() as available:
            available.bind(("127.0.0.1", 0))
            self.port = available.getsockname()[1]
        self.url = "http://127.0.0.1:" + str(self.port) + "/"
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def info(self):
        return launcher.request_json(self.url + "api/desktop-info")

    def launch(self):
        return subprocess.run([sys.executable, str(self.root / "scripts" / "desktop_launcher.py"),
                               "--port", str(self.port), "--no-open"],
                              capture_output=True, text=True, timeout=25)

    def stop(self):
        info = self.info()
        if info and info.get("app") == launcher.APP_ID and info.get("root") == str(self.root):
            local = launcher.request_json(self.url + "api/local")
            launcher.request_json(self.url + "api/desktop-shutdown", data=b"", headers={
                "Origin": self.url.rstrip("/"), "X-Figure-Token": local["token"],
            })
            deadline = time.monotonic() + 5
            while launcher.port_in_use(self.port) and time.monotonic() < deadline:
                time.sleep(0.05)

    def tearDown(self):
        self.stop()
        self.temporary.cleanup()

    def test_fingerprint_tracks_source_but_not_saved_data(self):
        before, _ = launcher.source_snapshot(self.root)
        (self.root / "local-assets").mkdir()
        (self.root / "local-assets" / "picture.png").write_bytes(b"saved user image")
        (self.root / "saved-project.json").write_text('{"project": true}')
        self.assertEqual(launcher.source_snapshot(self.root)[0], before)
        (self.root / "style.css").write_text("body { color: red; }", encoding="utf-8")
        self.assertNotEqual(launcher.source_snapshot(self.root)[0], before)

    def test_repeated_launch_reuses_and_source_changes_restart(self):
        first = self.launch()
        self.assertEqual(first.returncode, 0, first.stderr)
        initial = self.info()
        self.assertEqual(initial["root"], str(self.root))
        self.assertEqual(initial["fingerprint"], launcher.source_snapshot(self.root)[0])
        second = self.launch()
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(self.info()["pid"], initial["pid"])
        self.assertIn("reused", second.stdout)
        self.assertTrue((self.root / ".desktop-runtime" / "server.log").is_file())
        with self.assertRaises(urllib.error.HTTPError) as denied:
            self.opener.open(self.url + ".desktop-runtime/server.log", timeout=2)
        self.assertEqual(denied.exception.code, 403)
        denied.exception.close()

        (self.root / "app.js").write_text("const live = 2;", encoding="utf-8")
        restarted = self.launch()
        self.assertEqual(restarted.returncode, 0, restarted.stderr)
        self.assertNotEqual(self.info()["pid"], initial["pid"])
        with self.opener.open(self.url + "app.js", timeout=2) as response:
            self.assertEqual(response.read(), b"const live = 2;")
            self.assertEqual(response.headers["Cache-Control"], "no-store")
        # Old browser responses can carry validators even after switching to
        # no-store. A future timestamp would otherwise force an incorrect 304.
        validators = {"If-Modified-Since": "Thu, 31 Dec 2099 23:59:59 GMT",
                      "If-None-Match": '"old-app"'}
        for method in ("GET", "HEAD"):
            request = urllib.request.Request(self.url + "app.js", headers=validators, method=method)
            with self.opener.open(request, timeout=2) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(response.read(), b"const live = 2;" if method == "GET" else b"")

    def test_backend_source_reload_ignores_bytecode_cache_and_shutdown_requires_auth(self):
        backend = self.root / "server.py"
        backend.write_bytes(backend.read_bytes() + b'\nHandler.server_version = "BackendOld"\n')
        # Make a valid old pyc, then preserve the source size/mtime across its edit.
        import os
        import py_compile
        py_compile.compile(str(backend), doraise=True)
        old_stat = backend.stat()
        first = self.launch()
        self.assertEqual(first.returncode, 0, first.stderr)
        initial = self.info()
        local = launcher.request_json(self.url + "api/local")
        for headers in ({"Origin": self.url.rstrip("/")},
                        {"Origin": "https://example.com", "X-Figure-Token": local["token"]}):
            request = urllib.request.Request(self.url + "api/desktop-shutdown", data=b"", headers=headers)
            with self.assertRaises(urllib.error.HTTPError) as denied:
                self.opener.open(request, timeout=2)
            self.assertEqual(denied.exception.code, 403)
            denied.exception.close()
        self.assertEqual(self.info()["pid"], initial["pid"])
        backend.write_bytes(backend.read_bytes().replace(b'"BackendOld"', b'"BackendNew"'))
        os.utime(backend, ns=(old_stat.st_atime_ns, old_stat.st_mtime_ns))
        second = self.launch()
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertNotEqual(self.info()["pid"], initial["pid"])
        with self.opener.open(self.url, timeout=2) as response:
            self.assertTrue(response.headers["Server"].startswith("BackendNew"))

    def test_unknown_service_is_unchanged_on_port_conflict(self):
        class OtherHandler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"another service")

            def log_message(self, *args):
                pass

        other = http.server.ThreadingHTTPServer(("127.0.0.1", self.port), OtherHandler)
        thread = threading.Thread(target=other.serve_forever, daemon=True)
        thread.start()
        try:
            result = self.launch()
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("occupied", result.stderr)
            with self.opener.open(self.url, timeout=2) as response:
                self.assertEqual(response.read(), b"another service")
        finally:
            other.shutdown()
            thread.join()
            other.server_close()


if __name__ == "__main__":
    unittest.main()
