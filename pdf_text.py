"""Local macOS text outlines for vector PDF; no client-selected files or commands."""

import hashlib
import json
import math
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import threading


MAX_PDF_TEXT_BODY = 2 * 1024 * 1024
MAX_TEXT_BODY = MAX_PDF_TEXT_BODY
MAX_OUTLINE_OUTPUT = 64 * 1024 * 1024
_PATH = re.compile(r"(?:-?(?:\d+(?:\.\d*)?|\.\d+)|[mlch]|\s)*\Z")


class PdfTextError(Exception):
    def __init__(self, status, message):
        self.status = status
        super().__init__(message)


def _validate(data):
    if not isinstance(data, dict) or set(data) != {"items"} or not isinstance(data["items"], list):
        raise PdfTextError(400, "Send text items for PDF outlining.")
    if len(data["items"]) > 2000:
        raise PdfTextError(413, "PDF export supports at most 2,000 text items per slide.")
    items, seen, characters = [], set(), 0
    fields = {"id", "text", "fontFamily", "fontSize", "fontWeight", "fontStyle"}
    for item in data["items"]:
        if not isinstance(item, dict) or set(item) != fields:
            raise PdfTextError(400, "A PDF text item has invalid fields.")
        identifier, text, family = item["id"], item["text"], item["fontFamily"]
        if (not isinstance(identifier, str) or not identifier or len(identifier) > 256
                or identifier in seen or any(ord(c) < 32 for c in identifier)):
            raise PdfTextError(400, "PDF text item identifiers must be unique, nonempty strings.")
        if not isinstance(text, str):
            raise PdfTextError(400, "PDF text must be a string.")
        # Newlines/tabs and Unicode format characters have legitimate text-layout roles.
        if any(ord(c) < 32 and c not in "\n\r\t" for c in text):
            raise PdfTextError(400, "PDF text contains an unsupported control character.")
        text = text.replace("\r\n", "\n").replace("\r", "\n")
        characters += len(text)
        if characters > 100000:
            raise PdfTextError(413, "PDF export supports at most 100,000 text characters per slide.")
        if (not isinstance(family, str) or not family.strip() or len(family) > 200
                or any(ord(c) < 32 for c in family)):
            raise PdfTextError(400, "The PDF font family is invalid.")
        size = item["fontSize"]
        if isinstance(size, bool) or not isinstance(size, (int, float)) or not 1 <= size <= 2000 or not math.isfinite(size):
            raise PdfTextError(400, "PDF font sizes must be between 1 and 2,000 pixels.")
        weight = item["fontWeight"]
        if isinstance(weight, bool) or str(weight) not in {"normal", "bold", *(str(n) for n in range(100, 1000, 100))}:
            raise PdfTextError(400, "The PDF font weight is invalid.")
        if item["fontStyle"] not in ("normal", "italic", "oblique"):
            raise PdfTextError(400, "The PDF font style is invalid.")
        seen.add(identifier)
        items.append({**item, "text": text, "fontWeight": str(weight)})
    try:
        payload = json.dumps({"items": items}, ensure_ascii=False, allow_nan=False).encode("utf-8")
    except (UnicodeError, ValueError):
        raise PdfTextError(400, "PDF text must contain valid Unicode.")
    if len(payload) > MAX_TEXT_BODY:
        raise PdfTextError(413, "The PDF text request is too large.")
    return items, payload


def _run(command, payload, timeout, output_limit):
    """Keep stdout/stderr off the Python heap and cap every returned read."""
    with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
        try:
            process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=output, stderr=errors)
            try:
                process.communicate(payload, timeout=timeout)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate()
                raise PdfTextError(503, "PDF text outlining timed out. Try a smaller slide and export again.")
        except OSError:
            raise PdfTextError(503, "PDF text outlining could not start. Install Apple's Command Line Tools with xcode-select --install, then restart the editor.")
        if output.tell() > output_limit:
            raise PdfTextError(413, "The outlined PDF text is too complex. Split this slide into smaller slides.")
        output.seek(0)
        errors.seek(0)
        return process.returncode, output.read(output_limit + 1), errors.read(16384)


class PdfTextOutliner:
    # Private temporary directories retain compiled helpers for the server process lifetime.
    _compiled = {}
    _compile_lock = threading.Lock()

    def __init__(self, root):
        self.source = Path(root) / "scripts" / "pdf_text.swift"

    @property
    def available(self):
        return sys.platform == "darwin" and Path("/usr/bin/xcrun").is_file() and self.source.is_file()

    def _executable(self):
        if not self.available:
            raise PdfTextError(503, "Vector PDF text export requires the local macOS editor and Apple's Command Line Tools. Open the editor with start.command on macOS.")
        try:
            source = self.source.read_bytes()
        except OSError:
            raise PdfTextError(503, "The PDF text helper is missing. Restore scripts/pdf_text.swift and restart the editor.")
        digest = hashlib.sha256(source).hexdigest()
        with self._compile_lock:
            cached = self._compiled.get(digest)
            if cached and cached[1].is_file():
                return cached[1]
            directory = tempfile.TemporaryDirectory(prefix="figure-editor-pdf-text-")
            folder = Path(directory.name)
            trusted_source, executable = folder / "pdf_text.swift", folder / "pdf_text"
            try:
                trusted_source.write_bytes(source)
                status, _, _ = _run(["/usr/bin/xcrun", "swiftc", "-O", "-module-cache-path", str(folder / "modules"),
                                     str(trusted_source), "-o", str(executable)], b"", 120, 16384)
                if status or not executable.is_file():
                    raise PdfTextError(503, "The PDF text helper could not compile. Install or update Apple's Command Line Tools with xcode-select --install, then restart the editor.")
            except Exception:
                directory.cleanup()
                raise
            self._compiled[digest] = (directory, executable)
            return executable

    def outline(self, data):
        items, payload = _validate(data)
        if not items:
            return {"outlines": [], "substitutions": []}
        executable = self._executable()
        status, output, _ = _run([str(executable)], payload, 30, MAX_OUTLINE_OUTPUT)
        try:
            result = json.loads(output)
        except (ValueError, UnicodeError):
            raise PdfTextError(503, "The PDF text helper returned an invalid response.")
        if status:
            error = result.get("error") if isinstance(result, dict) else None
            raise PdfTextError(422, error[:1000] if isinstance(error, str) else "This text cannot be exported as vector outlines.")
        if not isinstance(result, dict) or not isinstance(result.get("outlines"), list) or len(result["outlines"]) != len(items):
            raise PdfTextError(503, "The PDF text helper returned incomplete outlines.")
        for item, outline in zip(items, result["outlines"]):
            if (not isinstance(outline, dict) or outline.get("id") != item["id"]
                    or not isinstance(outline.get("lines"), list) or len(outline["lines"]) != len(item["text"].split("\n"))):
                raise PdfTextError(503, "The PDF text helper returned incomplete lines.")
            for line in outline["lines"]:
                width, path = (line.get("width"), line.get("path")) if isinstance(line, dict) else (None, None)
                if (not isinstance(width, (int, float)) or isinstance(width, bool) or not math.isfinite(width) or width < 0
                        or not isinstance(path, str) or not _PATH.fullmatch(path)):
                    raise PdfTextError(503, "The PDF text helper returned invalid geometry.")
        substitutions = result.get("substitutions", [])
        if not isinstance(substitutions, list) or any(not isinstance(entry, dict) or set(entry) != {"id", "requested", "actual"}
                or not all(isinstance(value, str) and len(value) <= 256 for value in entry.values()) for entry in substitutions):
            raise PdfTextError(503, "The PDF text helper returned invalid font information.")
        return {"outlines": result["outlines"], "substitutions": substitutions}
