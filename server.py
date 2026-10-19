#!/usr/bin/env python3
"""Loopback-only Figure Editor server with an explicitly authorized Finder bridge."""

import argparse
import hashlib
import http.server
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import subprocess
import sys
import tempfile
import threading
from urllib.parse import unquote, urlsplit


IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".tif", ".tiff", ".bmp", ".avif", ".heic", ".heif", ".ico"}
MAX_BODY = 8192
MAX_SOURCE_BYTES = 25 * 1024 * 1024  # Same per-image limit as the browser importer.
CHOOSER_SCRIPT = '''on run argv
    try
        set selectedFile to choose file with prompt (item 1 of argv) of type {"public.image"} without invisibles
        return POSIX path of selectedFile
    on error number -128
        return ""
    end try
end run'''


class LocateError(Exception):
    def __init__(self, status, message):
        self.status = status
        super().__init__(message)


def relative_path(value):
    """Accept portable relative paths without normalizing traversal away."""
    if (not value or value.startswith("/") or "\\" in value
            or re.match(r"^[A-Za-z]:", value)
            or any(part in {"..", "."} or part.startswith(".") for part in value.split("/"))):
        raise LocateError(400, "The asset has an invalid relative path.")
    return PurePosixPath(value)


def descriptor(value):
    if not isinstance(value, dict):
        raise LocateError(400, "An asset descriptor is required.")
    result = {}
    limits = {"id": 256, "name": 1024, "relativePath": 4096, "fingerprint": 71, "linkToken": 256}
    for key, limit in limits.items():
        item = value.get(key)
        if item is None and key not in {"id", "name"}:
            continue
        if not isinstance(item, str) or not item or len(item) > limit or any(ord(c) < 32 for c in item):
            raise LocateError(400, "The asset descriptor is invalid.")
        result[key] = item
    if "relativePath" in result:
        relative_path(result["relativePath"])
    if "fingerprint" in result:
        digest = result["fingerprint"].removeprefix("sha256:")
        if not re.fullmatch(r"[0-9a-fA-F]{64}", digest):
            raise LocateError(400, "The asset fingerprint is invalid.")
        result["fingerprint"] = digest.lower()
    return result


class Locator:
    def __init__(self, root):
        self.root = root
        self.lock = threading.Lock()
        self.cache_path = root / ".local-locations.json"
        self.locations = {}
        try:
            if not self.cache_path.is_symlink() and self.cache_path.stat().st_size <= 1024 * 1024:
                saved = json.loads(self.cache_path.read_text(encoding="utf-8"))
                if isinstance(saved, dict):
                    self.locations = {k: v for k, v in list(saved.items())[-512:]
                                      if isinstance(k, str) and re.fullmatch(r"[0-9a-f]{64}", k)
                                      and isinstance(v, str) and len(v) <= 8192}
        except (OSError, ValueError):
            pass

    @staticmethod
    def image_file(path):
        try:
            if not Path(path).is_absolute():
                return None
            resolved = Path(path).resolve(strict=True)
            return resolved if resolved.is_file() and resolved.suffix.lower() in IMAGE_EXTENSIONS else None
        except (OSError, ValueError, RuntimeError):
            return None

    def source_path(self, asset):
        if not asset.get("relativePath") or not asset.get("fingerprint"):
            return None
        candidate = self.root / relative_path(asset["relativePath"])
        try:
            resolved = candidate.resolve()
            resolved.relative_to(self.root)
        except (OSError, ValueError, RuntimeError):
            raise LocateError(400, "The asset path is outside this project.")
        image = self.image_file(resolved)
        if image is None:
            return None
        try:
            if image.stat().st_size > MAX_SOURCE_BYTES:
                return None
            digest = hashlib.sha256()
            with image.open("rb") as stream:
                remaining = MAX_SOURCE_BYTES + 1
                while remaining:
                    block = stream.read(min(1024 * 1024, remaining))
                    if not block:
                        break
                    digest.update(block)
                    remaining -= len(block)
                if not remaining:
                    return None
            return image if secrets.compare_digest(digest.hexdigest(), asset["fingerprint"]) else None
        except OSError:
            return None

    def choose(self, name):
        prompt = "Choose the original image for “" + name + "” to show it in Finder."
        try:
            result = subprocess.run(["/usr/bin/osascript", "-e", CHOOSER_SCRIPT, prompt],
                                    capture_output=True, text=True, check=True, timeout=120)
        except subprocess.TimeoutExpired:
            raise LocateError(504, "The file picker timed out. Try Locate again.")
        except (OSError, subprocess.CalledProcessError):
            raise LocateError(500, "The macOS file picker could not be opened.")
        chosen = result.stdout.rstrip("\r\n")
        if not chosen:
            return None
        image = self.image_file(chosen)
        if image is None:
            raise LocateError(400, "Choose an existing image file.")
        return image

    def remember(self, key, path):
        self.locations[key] = str(path)
        self.locations = dict(list(self.locations.items())[-512:])
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=self.root,
                                             prefix=".local-locations-", delete=False) as stream:
                temporary = Path(stream.name)
                json.dump(self.locations, stream, ensure_ascii=False)
            os.replace(temporary, self.cache_path)
        except OSError:
            # An unwritable project can still remember selections for this session.
            pass
        finally:
            if temporary is not None:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    pass

    def locate(self, asset):
        if sys.platform != "darwin":
            raise LocateError(501, "Locate in Finder is available on macOS.")
        if not self.lock.acquire(blocking=False):
            raise LocateError(409, "A Locate request is already open. Finish it before trying again.")
        try:
            key = hashlib.sha256(json.dumps(asset, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
            remembered = self.locations.get(key)
            image = self.image_file(remembered) if remembered else None
            if image is None:
                image = self.source_path(asset)
            picked = image is None
            if picked:
                image = self.choose(asset["name"])
                if image is None:
                    return {"status": "cancelled"}
            try:
                subprocess.run(["/usr/bin/open", "-R", str(image)], capture_output=True, check=True, timeout=10)
            except (OSError, subprocess.SubprocessError):
                raise LocateError(500, "Finder could not reveal the image. Try Locate again.")
            if picked:
                self.remember(key, image)
            return {"status": "revealed"}
        finally:
            self.lock.release()


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(args[2].root), **kwargs)

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def end_headers(self):
        # Local source edits should be visible after reloading the editor.
        if not urlsplit(self.path).path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def json_response(self, status, value):
        data = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def trusted_request(self, require_origin=False):
        hosts = self.headers.get_all("Host", [])
        allowed = {"127.0.0.1:" + str(self.server.server_port), "localhost:" + str(self.server.server_port)}
        if len(hosts) != 1 or hosts[0] not in allowed:
            raise LocateError(403, "This server accepts local Figure Editor requests only.")
        origins = self.headers.get_all("Origin", [])
        if (len(origins) > 1 or (require_origin and not origins)
                or (origins and origins[0] != "http://" + hosts[0])
                or self.headers.get("Sec-Fetch-Site") not in {None, "same-origin", "none"}):
            raise LocateError(403, "This request must come from the local Figure Editor.")

    def static_allowed(self):
        raw = unquote(urlsplit(self.path).path)
        if "\\" in raw or "\x00" in raw or any(part.startswith(".") for part in raw.split("/") if part):
            return False
        try:
            resolved = (self.server.root / raw.lstrip("/")).resolve().relative_to(self.server.root)
            return not any(part.startswith(".") for part in resolved.parts)
        except (OSError, ValueError, RuntimeError):
            return False

    def do_GET(self):
        try:
            self.trusted_request()
            path = urlsplit(self.path).path
            if path == "/api/local":
                self.json_response(200, {"app": "figure-editor-local", "version": 1,
                                         "locate": sys.platform == "darwin", "token": self.server.token})
            elif path.startswith("/api/"):
                self.json_response(404, {"error": "Unknown local API."})
            elif not self.static_allowed():
                self.send_error(403, "This file is not served.")
            else:
                super().do_GET()
        except LocateError as error:
            self.json_response(error.status, {"error": str(error)})

    def do_HEAD(self):
        try:
            self.trusted_request()
            if urlsplit(self.path).path.startswith("/api/"):
                self.json_response(405, {"error": "Use GET for this endpoint."})
            elif not self.static_allowed():
                self.send_error(403, "This file is not served.")
            else:
                super().do_HEAD()
        except LocateError as error:
            self.json_response(error.status, {"error": str(error)})

    def list_directory(self, path):
        self.send_error(403, "Directory listings are disabled.")
        return None

    def do_POST(self):
        try:
            self.trusted_request(require_origin=True)
            if urlsplit(self.path).path != "/api/locate":
                raise LocateError(404, "Unknown local API.")
            tokens = self.headers.get_all("X-Figure-Token", [])
            if len(tokens) != 1 or not secrets.compare_digest(tokens[0].encode(), self.server.token.encode()):
                raise LocateError(403, "Reload the local Figure Editor before using Locate.")
            if self.headers.get_content_type() != "application/json" or self.headers.get("Transfer-Encoding"):
                raise LocateError(400, "Send a JSON asset descriptor.")
            lengths = self.headers.get_all("Content-Length", [])
            if (len(lengths) != 1 or len(lengths[0]) > 5 or not lengths[0].isascii()
                    or not lengths[0].isdigit() or not 0 < int(lengths[0]) <= MAX_BODY):
                raise LocateError(413, "The Locate request is too large or missing its length.")
            try:
                data = json.loads(self.rfile.read(int(lengths[0])))
            except (OSError, ValueError):
                raise LocateError(400, "The Locate request is not valid JSON.")
            if not isinstance(data, dict):
                raise LocateError(400, "An asset descriptor is required.")
            asset = descriptor(data.get("asset"))
            self.json_response(200, self.server.locator.locate(asset))
        except LocateError as error:
            self.json_response(error.status, {"error": str(error)})


def create_server(root, port=8766):
    root = Path(root).resolve(strict=True)
    if not root.is_dir():
        raise ValueError("The app root must be a directory.")
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.root = root
    server.token = secrets.token_urlsafe(32)
    server.locator = Locator(root)
    return server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8766)
    args = parser.parse_args()
    server = create_server(Path(__file__).parent, args.port)
    print("Figure Editor is running at http://127.0.0.1:" + str(server.server_port) + "/", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
