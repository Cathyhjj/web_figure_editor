"""Read one stable, allowlisted PowerPoint clipboard package on local macOS.

The helper never changes the clipboard. Its stdout is package bytes, not a dump
of clipboard formats. Call only in response to an explicit paste action.
"""

import hashlib
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import threading


MAX_CLIPBOARD_BYTES = 100 * 1024 * 1024
_SOURCE = Path(__file__).resolve().parent / "scripts" / "pptx_clipboard.swift"
_XCRUN = Path("/usr/bin/xcrun")
_compiled = {}
_compile_lock = threading.Lock()
_read_lock = threading.Lock()
_warmup_lock = threading.Lock()
_warmup_started = False
_HASH = re.compile(r"[a-fA-F0-9]{64}\Z")
_UNAVAILABLE = (
    "PowerPoint clipboard paste requires the local macOS editor and Apple's "
    "Command Line Tools. Use Import PPTX if the native helper is unavailable."
)


def clipboard_available():
    """Report helper prerequisites without reading or changing the clipboard."""
    return sys.platform == "darwin" and _XCRUN.is_file() and _SOURCE.is_file()


def clipboard_ready():
    """Check the compiled source cache without compiling or waiting on warmup."""
    if not clipboard_available():
        return False
    try:
        digest = hashlib.sha256(_SOURCE.read_bytes()).hexdigest()
    except OSError:
        return False
    # Compilation holds this lock; capability requests must remain responsive.
    if not _compile_lock.acquire(blocking=False):
        return False
    try:
        cached = _compiled.get(digest)
        return bool(cached and cached[1].is_file())
    finally:
        _compile_lock.release()


def start_clipboard_helper():
    """Warm the compiler cache once in the background, without clipboard access."""
    global _warmup_started
    if not clipboard_available():
        return
    with _warmup_lock:
        if _warmup_started:
            return
        _warmup_started = True

        def warmup():
            try:
                _executable()
            except ValueError:
                # Ordinary image paste remains available. An explicit native
                # paste can retry compilation and show the actionable error.
                pass

        thread = threading.Thread(
            target=warmup, name="figure-editor-pptx-clipboard", daemon=True
        )
        try:
            thread.start()
        except RuntimeError:
            # Resource-limited startup must not disable the rest of the editor.
            pass


def _run(command, payload, timeout, output_limit):
    """Capture output in private temporary files; bound reads into Python."""
    with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
        try:
            process = subprocess.Popen(
                command, stdin=subprocess.PIPE, stdout=output, stderr=errors
            )
            try:
                process.communicate(payload, timeout=timeout)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate()
                raise ValueError(
                    "PowerPoint clipboard paste timed out. Copy the slide and try again."
                ) from None
        except OSError:
            raise ValueError(_UNAVAILABLE) from None
        if output.tell() > output_limit:
            raise ValueError("The PowerPoint clipboard package exceeds the 100 MB limit.")
        output.seek(0)
        # Never expose compiler/native stderr, which could include local paths.
        return process.returncode, output.read(output_limit + 1)


def _executable():
    if not clipboard_available():
        raise ValueError(_UNAVAILABLE)
    try:
        source = _SOURCE.read_bytes()
    except OSError:
        raise ValueError("The PowerPoint clipboard helper is missing. Restart the editor.") from None
    digest = hashlib.sha256(source).hexdigest()
    with _compile_lock:
        cached = _compiled.get(digest)
        if cached and cached[1].is_file():
            return cached[1]
        directory = tempfile.TemporaryDirectory(prefix="figure-editor-pptx-clipboard-")
        folder = Path(directory.name)
        trusted_source = folder / "pptx_clipboard.swift"
        executable = folder / "pptx_clipboard"
        try:
            trusted_source.write_bytes(source)
            status, _ = _run(
                [str(_XCRUN), "swiftc", "-O", "-module-cache-path",
                 str(folder / "modules"), str(trusted_source), "-o", str(executable)],
                b"", 120, 16384,
            )
            if status or not executable.is_file():
                raise ValueError(
                    "The PowerPoint clipboard helper could not compile. Install or "
                    "update Apple's Command Line Tools, then restart the editor."
                )
        except Exception:
            directory.cleanup()
            raise
        _compiled[digest] = (directory, executable)
        return executable


def read_powerpoint_clipboard(preview_sha256=None):
    """Return captured package bytes, or None for absent/nonmatching content.

    When a browser paste supplied a PNG, pass its SHA-256. The helper requires an
    identical raw public.png on the same pasteboard item before returning Office
    bytes. All format checks and reads occur within one changeCount snapshot.
    """
    if preview_sha256 is not None and (
        not isinstance(preview_sha256, str) or not _HASH.fullmatch(preview_sha256)
    ):
        raise ValueError("The pasted preview fingerprint must be a SHA-256 hex digest.")
    executable = _executable()
    payload = preview_sha256.lower().encode("ascii") if preview_sha256 is not None else b""
    with _read_lock:
        status, output = _run([str(executable)], payload, 15, MAX_CLIPBOARD_BYTES)
    if status == 10:
        if output:
            raise ValueError("The PowerPoint clipboard helper returned an invalid response.")
        return None
    if status == 20:
        raise ValueError("The clipboard changed during paste. Copy the slide and try again.")
    if status == 21:
        raise ValueError("The PowerPoint clipboard package or preview exceeds the 100 MB limit.")
    if status == 23:
        raise ValueError("The clipboard contains multiple PowerPoint packages. Copy one slide selection and try again.")
    if status != 0 or not output or len(output) > MAX_CLIPBOARD_BYTES:
        raise ValueError("The PowerPoint clipboard could not be read. Copy the slide and try again.")
    return output
