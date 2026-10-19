#!/usr/bin/env python3
"""Open the live checkout, maintaining one authenticated local desktop server."""

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import threading
import time
import types
import urllib.error
import urllib.request
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = Path(__file__).resolve()
APP_ID = "figure-editor-desktop"


class LaunchError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())


def source_snapshot(root=ROOT):
    """Include dirty source edits and HEAD, while excluding projects and images."""
    files = {path.name: path.read_bytes() for path in root.iterdir()
             if path.is_file() and path.suffix in {".py", ".js", ".html", ".css"}}
    files["scripts/desktop_launcher.py"] = (root / "scripts" / "desktop_launcher.py").read_bytes()
    try:
        result = subprocess.run(["/usr/bin/git", "-C", str(root), "rev-parse", "HEAD"],
                                capture_output=True, check=True, timeout=3)
        files["git-HEAD"] = result.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        files["git-HEAD"] = b""
    digest = hashlib.sha256()
    for name, data in sorted(files.items()):
        digest.update(name.encode() + b"\0" + str(len(data)).encode() + b"\0" + data)
    return digest.hexdigest(), files


def request_json(url, data=None, headers=None):
    request = urllib.request.Request(url, data=data, headers=headers or {})
    try:
        with OPENER.open(request, timeout=1) as response:
            raw = response.read(16385)
            if response.status != 200 or len(raw) > 16384:
                return None
        result = json.loads(raw)
        return result if isinstance(result, dict) else None
    except urllib.error.HTTPError as error:
        error.close()
        return None
    except (OSError, urllib.error.URLError, ValueError):
        return None


def owned_info(url):
    info = request_json(url + "api/desktop-info")
    if (info and info.get("app") == APP_ID and info.get("version") == 1
            and info.get("root") == str(ROOT) and type(info.get("pid")) is int
            and isinstance(info.get("fingerprint"), str)):
        return info
    return None


def port_in_use(port):
    with socket.socket() as connection:
        connection.settimeout(0.5)
        return connection.connect_ex(("127.0.0.1", port)) == 0


def stop_owned_server(url):
    """Only the exact checkout's authenticated endpoint can stop a server."""
    if not owned_info(url):
        raise LaunchError("The existing service cannot be verified as this checkout.")
    local = request_json(url + "api/local")
    token = local.get("token") if local else None
    if not isinstance(token, str) or not token:
        raise LaunchError("The existing Figure Editor server could not authorize a restart.")
    result = request_json(url + "api/desktop-shutdown", data=b"", headers={
        "Origin": url.rstrip("/"), "X-Figure-Token": token,
    })
    if not result or result.get("status") != "stopping":
        raise LaunchError("The existing Figure Editor server could not restart safely.")


def serve(port):
    # Compile the snapshot itself: timestamp-based bytecode caches must not select
    # an older backend after an edit or checkout with matching size and mtime.
    fingerprint, files = source_snapshot()
    sys.path.insert(0, str(ROOT))
    module = types.ModuleType("figure_editor_live_server")
    module.__file__ = str(ROOT / "server.py")
    exec(compile(files["server.py"], module.__file__, "exec"), module.__dict__)

    class DesktopHandler(module.Handler):
        def send_header(self, keyword, value):
            if keyword.lower() == "cache-control":
                value = "no-store"
            super().send_header(keyword, value)

        def do_GET(self):
            path = urlsplit(self.path).path
            if not path.startswith("/api/"):
                # A browser can retain an older response from before this
                # launcher added no-store. Do not accept timestamp validators,
                # which can miss same-size edits within one second.
                del self.headers["If-Modified-Since"]
                del self.headers["If-None-Match"]
            if path != "/api/desktop-info":
                return super().do_GET()
            try:
                self.trusted_request()
                self.json_response(200, {"app": APP_ID, "version": 1, "root": str(ROOT),
                                         "pid": os.getpid(), "fingerprint": fingerprint})
            except module.LocateError as error:
                self.json_response(error.status, {"error": str(error)})

        def do_HEAD(self):
            if not urlsplit(self.path).path.startswith("/api/"):
                del self.headers["If-Modified-Since"]
                del self.headers["If-None-Match"]
            return super().do_HEAD()

        def do_POST(self):
            if urlsplit(self.path).path != "/api/desktop-shutdown":
                return super().do_POST()
            try:
                self.trusted_request(require_origin=True)
                tokens = self.headers.get_all("X-Figure-Token", [])
                if (len(tokens) != 1 or not secrets.compare_digest(
                        tokens[0].encode(), self.server.token.encode())):
                    raise module.LocateError(403, "A local Figure Editor token is required.")
                self.json_response(200, {"status": "stopping"})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
            except module.LocateError as error:
                self.json_response(error.status, {"error": str(error)})

    local = module.create_server(ROOT, port)
    local.RequestHandlerClass = DesktopHandler
    print("Serving live checkout: " + str(ROOT), flush=True)
    print("Source fingerprint: " + fingerprint, flush=True)
    try:
        local.serve_forever(poll_interval=0.1)
    finally:
        local.server_close()


def ensure_server(port, state_dir):
    state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    url = "http://127.0.0.1:" + str(port) + "/"
    with (state_dir / ("launch-" + str(port) + ".lock")).open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        fingerprint, _ = source_snapshot()
        info = owned_info(url)
        if info and info["fingerprint"] == fingerprint:
            return url, fingerprint, "reused"
        if info:
            stop_owned_server(url)
            deadline = time.monotonic() + 10
            while port_in_use(port) and time.monotonic() < deadline:
                time.sleep(0.1)
            if port_in_use(port):
                raise LaunchError("The old Figure Editor server did not release its port.")
        elif port_in_use(port):
            raise LaunchError("Port " + str(port) + " is occupied by another or older service. "
                              "Close its Terminal/server, then open Figure Editor again. "
                              "No unrelated service was stopped.")
        log_path = state_dir / "server.log"
        with log_path.open("ab") as log:
            process = subprocess.Popen([sys.executable, str(SCRIPT), "--serve", "--port", str(port)],
                                       cwd=str(ROOT), stdin=subprocess.DEVNULL, stdout=log,
                                       stderr=subprocess.STDOUT, start_new_session=True, close_fds=True)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            info = owned_info(url)
            if info and info["pid"] == process.pid and info["fingerprint"] == fingerprint:
                return url, fingerprint, "started"
            if process.poll() is not None:
                raise LaunchError("Figure Editor could not start. Details: " + str(log_path))
            if info and info["pid"] == process.pid and info["fingerprint"] != fingerprint:
                stop_owned_server(url)
                raise LaunchError("The source changed during startup. Open Figure Editor again.")
            time.sleep(0.1)
        raise LaunchError("Figure Editor did not become ready. Details: " + str(log_path))


def open_browser(url):
    args = ["/usr/bin/open"]
    if Path("/Applications/Google Chrome.app").is_dir():
        args += ["-a", "/Applications/Google Chrome.app"]
    subprocess.run(args + [url], check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--state-dir", type=Path, default=ROOT / ".desktop-runtime")
    parser.add_argument("--no-open", action="store_true")
    parser.add_argument("--serve", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("port must be between 1 and 65535")
    try:
        if args.serve:
            serve(args.port)
        else:
            url, fingerprint, action = ensure_server(args.port, args.state_dir)
            print("Figure Editor " + action + ": " + url, flush=True)
            if not args.no_open:
                open_browser(url + "?source=" + fingerprint[:16])
    except (LaunchError, OSError, subprocess.SubprocessError) as error:
        message = str(error)
        print(message, file=sys.stderr, flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
