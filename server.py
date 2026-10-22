#!/usr/bin/env python3
"""Loopback-only Figure Editor server with an explicitly authorized Finder bridge."""

import argparse
import base64
import binascii
from contextlib import ExitStack
import errno
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
from xml.parsers import expat
from pdf_text import MAX_PDF_TEXT_BODY, PdfTextError, PdfTextOutliner
from pptx_import import MAX_PPTX_BODY, PptxImportError, import_pptx
from pptx_clipboard import clipboard_available, clipboard_ready, start_clipboard_helper, read_powerpoint_clipboard


IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".tif", ".tiff", ".bmp", ".avif", ".heic", ".heif", ".ico", ".mp4", ".html", ".htm"}
MAX_BODY = 8192
MAX_SOURCE_BYTES = 25 * 1024 * 1024  # Same per-image limit as the browser importer.
MAX_CLIPBOARD_BODY = 4 * ((MAX_SOURCE_BYTES + 2) // 3) + 1024
CLIPBOARD_DIRECTORY = ("local-assets", "pasted")


class LocateError(Exception):
    def __init__(self, status, message):
        self.status = status
        super().__init__(message)


def clipboard_image(value):
    """Decode an image without accepting a destination or rewriting its bytes."""
    if not isinstance(value, dict) or set(value) != {"dataUrl"} or not isinstance(value["dataUrl"], str):
        raise LocateError(400, "Send one clipboard image as a dataUrl.")
    header, separator, encoded = value["dataUrl"].partition(",")
    formats = {"data:image/png;base64": "png", "data:image/jpeg;base64": "jpg",
               "data:image/webp;base64": "webp", "data:image/svg+xml;base64": "svg"}
    extension = formats.get(header)
    if not separator or not extension:
        raise LocateError(400, "Only base64 PNG, JPEG, WebP, and SVG images can be saved.")
    if len(encoded) > 4 * ((MAX_SOURCE_BYTES + 2) // 3):
        raise LocateError(413, "Clipboard images must be at most 25 MB.")
    try:
        data = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error):
        raise LocateError(400, "The clipboard image has invalid base64 data.")
    if not data:
        raise LocateError(400, "The clipboard image is empty.")
    if len(data) > MAX_SOURCE_BYTES:
        raise LocateError(413, "Clipboard images must be at most 25 MB.")
    valid = False
    if extension == "png":
        valid = data.startswith(b"\x89PNG\r\n\x1a\n")
    elif extension == "jpg":
        valid = data.startswith(b"\xff\xd8\xff")
    elif extension == "webp":
        valid = (len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP"
                 and int.from_bytes(data[4:8], "little") == len(data) - 8)
    else:
        # Expat does not load external DTDs. Reject entity declarations as well,
        # so validating the root cannot expand attacker-controlled entities.
        parser = expat.ParserCreate(namespace_separator="}")
        roots = []
        def element(name, attributes):
            if not roots:
                roots.append(name)
        def reject_entity(*args):
            raise ValueError("SVG entities are unsupported")
        parser.StartElementHandler = element
        parser.EntityDeclHandler = reject_entity
        parser.ExternalEntityRefHandler = lambda *args: 0
        try:
            parser.Parse(data, True)
            valid = roots in (["svg"], ["http://www.w3.org/2000/svg}svg"])
        except (expat.ExpatError, ValueError):
            pass
    if not valid:
        raise LocateError(400, "The clipboard image contents do not match its image format.")
    return data, extension


class ClipboardImages:
    """Content-addressed local originals, published atomically without overwrite."""
    def __init__(self, root):
        self.root = root

    @staticmethod
    def verify(directory, filename, expected):
        try:
            fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        except OSError as error:
            if error.errno in {errno.ELOOP, errno.ENOTDIR}:
                raise LocateError(409, "The clipboard image destination is an unsafe link or conflicting file.")
            raise
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            os.close(fd)
            raise LocateError(409, "A conflicting clipboard image already exists; it was not changed.")
        with os.fdopen(fd, "rb") as stream:
            metadata = os.fstat(stream.fileno())
            if (not stat.S_ISREG(metadata.st_mode) or metadata.st_size != len(expected)
                    or stream.read(len(expected) + 1) != expected):
                raise LocateError(409, "A conflicting clipboard image already exists; it was not changed.")

    def save(self, value):
        data, extension = clipboard_image(value)
        digest = hashlib.sha256(data).hexdigest()
        filename = digest + "." + extension
        try:
            with ExitStack() as opened:
                flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
                directory = os.open(self.root, flags)
                opened.callback(os.close, directory)
                for component in CLIPBOARD_DIRECTORY:
                    try:
                        os.mkdir(component, mode=0o700, dir_fd=directory)
                    except FileExistsError:
                        pass
                    directory = os.open(component, flags, dir_fd=directory)
                    opened.callback(os.close, directory)
                try:
                    self.verify(directory, filename, data)
                except FileNotFoundError:
                    temporary = ".pasted-" + secrets.token_hex(16)
                    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                 0o600, dir_fd=directory)
                    try:
                        with os.fdopen(fd, "wb") as stream:
                            stream.write(data)
                            stream.flush()
                            os.fsync(stream.fileno())
                        try:
                            os.link(temporary, filename, src_dir_fd=directory, dst_dir_fd=directory,
                                    follow_symlinks=False)
                        except FileExistsError:
                            # A concurrent identical save is safe; conflicts still fail verification.
                            pass
                        self.verify(directory, filename, data)
                    finally:
                        os.unlink(temporary, dir_fd=directory)
        except OSError as error:
            if error.errno in {errno.ELOOP, errno.ENOTDIR}:
                raise LocateError(409, "The clipboard image folder contains an unsafe link or conflicting file.")
            raise LocateError(500, "Could not save the clipboard image. Check folder permissions and available disk space.")
        return {"relativePath": "/".join((*CLIPBOARD_DIRECTORY, filename)), "fingerprint": digest}


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
            legacy_key = hashlib.sha256(json.dumps(asset, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
            # Refresh changes image bytes, while its immutable link token still
            # identifies the same source. Relink/undo use their own token.
            identity = {"id": asset["id"], "linkToken": asset["linkToken"]} if asset.get("linkToken") else asset
            key = hashlib.sha256(json.dumps(identity, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
            remembered = self.locations.get(key)
            image = self.image_file(remembered) if remembered else None
            migrated = False
            if image is None and key != legacy_key:
                remembered = self.locations.get(legacy_key)
                image = self.image_file(remembered) if remembered else None
                migrated = image is not None
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
            if migrated or discovered:
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
        if raw.lstrip("/").split("/", 1)[0].casefold() == CLIPBOARD_DIRECTORY[0]:
            return False
        try:
            resolved = (self.server.root / raw.lstrip("/")).resolve().relative_to(self.server.root)
            # Clipboard SVG originals may contain active content. They are available
            # to Finder, never served under the editor's origin, even through aliases.
            return (not any(part.startswith(".") for part in resolved.parts)
                    and (not resolved.parts or resolved.parts[0].casefold() != CLIPBOARD_DIRECTORY[0]))
        except (OSError, ValueError, RuntimeError):
            return False

    def do_GET(self):
        try:
            self.trusted_request()
            path = urlsplit(self.path).path
            if path == "/api/local":
                self.json_response(200, {"app": "figure-editor-local", "version": 1,
                                         "locate": sys.platform == "darwin", "saveClipboardImage": True,
                                         "pdfTextOutlines": self.server.pdf_text.available,
                                         "pptxImport": True,
                                         "pptxPaste": True, "pptxClipboard": clipboard_available(),
                                         "pptxClipboardReady": clipboard_ready(),
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
            if path not in {"/api/locate", "/api/clipboard-image", "/api/pdf-text", "/api/pptx-import", "/api/pptx-paste", "/api/pptx-clipboard"}:
                raise LocateError(404, "Unknown local API.")
            clipboard = path == "/api/clipboard-image"
            pdf_text = path == "/api/pdf-text"
            pptx = path in {"/api/pptx-import", "/api/pptx-paste"}
            label = "PPTX import" if pptx else "PDF text" if pdf_text else "clipboard image" if clipboard else "Locate"
            limit = MAX_PPTX_BODY if pptx else MAX_PDF_TEXT_BODY if pdf_text else MAX_CLIPBOARD_BODY if clipboard else MAX_BODY
            tokens = self.headers.get_all("X-Figure-Token", [])
            if len(tokens) != 1 or not secrets.compare_digest(tokens[0].encode(), self.server.token.encode()):
                raise LocateError(403, "Reload the local Figure Editor before using local files.")
            if self.headers.get_content_type() != "application/json" or self.headers.get("Transfer-Encoding"):
                raise LocateError(400, "Send a JSON PPTX import request." if pptx else "Send JSON text items for PDF outlining." if pdf_text else "Send a JSON clipboard image." if clipboard else "Send a JSON asset descriptor.")
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
            if path == "/api/pptx-clipboard":
                if not isinstance(data,dict) or set(data)-{'previewSha256'}:
                    raise LocateError(400, "Send an optional clipboard image fingerprint.")
                digest=data.get('previewSha256')
                if 'previewSha256' in data and (not isinstance(digest,str) or not re.fullmatch(r'[a-f0-9]{64}',digest)):
                    raise LocateError(400, "The clipboard image fingerprint is invalid.")
                try:
                    raw=read_powerpoint_clipboard(digest)
                except ValueError as error:
                    self.json_response(422,{'error':str(error),'nativeUnavailable':True})
                    return
                result={'available':False} if raw is None else import_pptx({'name':'PowerPoint clipboard.pptx','data':base64.b64encode(raw).decode()},single_slide=True)
            elif path == "/api/pptx-paste":
                if not isinstance(data,dict) or set(data)!={'data'}:
                    raise LocateError(400,"Send an embedded PowerPoint slide package.")
                result=import_pptx({'name':'PowerPoint clipboard.pptx','data':data['data']},single_slide=True)
            elif pptx:
                result = import_pptx(data)
            elif pdf_text:
                result = self.server.pdf_text.outline(data)
            elif clipboard:
                result = self.server.clipboard_images.save(data)
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
    server.clipboard_images = ClipboardImages(root)
    server.pdf_text = PdfTextOutliner(root)
    if (root / 'scripts' / 'pptx_clipboard.swift').is_file():
        start_clipboard_helper()
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
