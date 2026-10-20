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
import stat
import subprocess
import sys
import tempfile
import threading
import unicodedata
from urllib.parse import unquote, urlsplit
from pdf_text import MAX_PDF_TEXT_BODY, PdfTextError, PdfTextOutliner
from pptx_import import MAX_PPTX_BODY, PptxImportError, import_pptx


IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".tif", ".tiff", ".bmp", ".avif", ".heic", ".heif", ".ico", ".mp4"}
MAX_BODY = 8192
MAX_SOURCE_BYTES = 25 * 1024 * 1024  # Same per-image limit as the browser importer.


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
        return image if self.matches_fingerprint(image, asset["fingerprint"]) else None

    @staticmethod
    def matches_fingerprint(image, fingerprint):
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
            return secrets.compare_digest(digest.hexdigest(), fingerprint)
        except OSError:
            return None

    def indexed_sources(self, asset):
        """Find bounded filename/path candidates without reading their contents."""
        name = asset["name"]
        if "/" in name or "\\" in name or Path(name).suffix.lower() not in IMAGE_EXTENSIONS:
            return []
        try:
            result = subprocess.run(["/usr/bin/mdfind", "-0", "-onlyin", str(Path.home()), "-name", name],
                                    capture_output=True, text=True, check=True, timeout=3)
        except (OSError, subprocess.SubprocessError, UnicodeError):
            return []
        # Never establish uniqueness from truncated results or an arbitrary subset.
        if len(result.stdout) > 128 * 1024:
            return []
        expected = PurePosixPath(asset.get("relativePath") or name).parts
        normalized = lambda parts: tuple(unicodedata.normalize("NFC", part) for part in parts)
        expected = normalized(expected)
        candidates = set()
        for raw in result.stdout.split("\0"):
            if not raw:
                continue
            path = Path(raw)
            if normalized((path.name,)) != normalized((name,)) or normalized(path.parts[-len(expected):]) != expected:
                continue
            image = self.image_file(path)
            if image is not None:
                candidates.add(image)
                if len(candidates) > 16:
                    return []
        return sorted(candidates)

    def discover_source(self, asset):
        candidates = self.indexed_sources(asset)
        # Locate reveals the source's current file, including edits made since
        # import. A unique exact filename/path match need not have old bytes.
        if len(candidates) == 1:
            return candidates[0]
        if not candidates:
            return None
        matches = []
        remaining = MAX_SOURCE_BYTES
        if asset.get("fingerprint"):
            for image in candidates:
                try:
                    metadata = image.stat()
                except OSError:
                    break
                # Do not hydrate cloud files, or hash an unbounded set of copies.
                if (getattr(metadata, "st_flags", 0) & getattr(stat, "SF_DATALESS", 0)
                        or metadata.st_size > remaining):
                    break
                remaining -= metadata.st_size
                match = self.matches_fingerprint(image, asset["fingerprint"])
                if match is None:
                    break
                if match:
                    matches.append(image)
            else:
                if len(matches) == 1:
                    return matches[0]
        raise LocateError(409, "Several files match this asset. Its original location is ambiguous; no file was opened.")

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
            discovered = False
            if image is None:
                image = self.discover_source(asset)
                discovered = image is not None
            if image is None:
                raise LocateError(404, "The source file could not be found on this Mac. It may have moved, been deleted, or not been indexed by Spotlight.")
            try:
                subprocess.run(["/usr/bin/open", "-R", str(image)], capture_output=True, check=True, timeout=10)
            except (OSError, subprocess.SubprocessError):
                raise LocateError(500, "Finder could not reveal the image. Try Locate again.")
            if discovered:
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
                                         "locate": sys.platform == "darwin",
                                         "pdfTextOutlines": self.server.pdf_text.available,
                                         "pptxImport": True,
                                         "token": self.server.token})
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
            path = urlsplit(self.path).path
            if path not in {"/api/locate", "/api/pdf-text", "/api/pptx-import"}:
                raise LocateError(404, "Unknown local API.")
            pdf_text = path == "/api/pdf-text"
            pptx = path == "/api/pptx-import"
            label = "PPTX import" if pptx else "PDF text" if pdf_text else "Locate"
            limit = MAX_PPTX_BODY if pptx else MAX_PDF_TEXT_BODY if pdf_text else MAX_BODY
            tokens = self.headers.get_all("X-Figure-Token", [])
            if len(tokens) != 1 or not secrets.compare_digest(tokens[0].encode(), self.server.token.encode()):
                raise LocateError(403, "Reload the local Figure Editor before using " + label + ".")
            if self.headers.get_content_type() != "application/json" or self.headers.get("Transfer-Encoding"):
                raise LocateError(400, "Send a JSON PPTX import request." if pptx else "Send JSON text items for PDF outlining." if pdf_text else "Send a JSON asset descriptor.")
            lengths = self.headers.get_all("Content-Length", [])
            if (len(lengths) != 1 or len(lengths[0]) > len(str(limit)) or not lengths[0].isascii()
                    or not lengths[0].isdigit() or not 0 < int(lengths[0]) <= limit):
                raise LocateError(413, "The " + label + " request is too large or missing its length.")
            try:
                body = self.rfile.read(int(lengths[0]))
                if len(body) != int(lengths[0]):
                    raise ValueError("incomplete request")
                data = json.loads(body)
            except (OSError, ValueError, RecursionError):
                raise LocateError(400, "The " + label + " request is not valid JSON.")
            if pptx:
                result = import_pptx(data)
            elif pdf_text:
                result = self.server.pdf_text.outline(data)
            else:
                if not isinstance(data, dict):
                    raise LocateError(400, "An asset descriptor is required.")
                result = self.server.locator.locate(descriptor(data.get("asset")))
            self.json_response(200, result)
        except (LocateError, PdfTextError, PptxImportError) as error:
            self.json_response(error.status, {"error": str(error)})


def create_server(root, port=8766):
    root = Path(root).resolve(strict=True)
    if not root.is_dir():
        raise ValueError("The app root must be a directory.")
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.root = root
    server.token = secrets.token_urlsafe(32)
    server.locator = Locator(root)
    server.pdf_text = PdfTextOutliner(root)
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
