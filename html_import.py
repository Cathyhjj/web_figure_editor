"""Bounded HTML/ZIP input for the isolated, offline Chromium figure renderer."""
import base64
import binascii
import hashlib
import io
import json
import mimetypes
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import tempfile
import threading
import zipfile

MAX_HTML_BYTES = 25 * 1024 * 1024
MAX_HTML_BODY = 4 * ((MAX_HTML_BYTES + 2) // 3) + 8192
MAX_EXPANDED = 100 * 1024 * 1024
RENDER_LOCK = threading.BoundedSemaphore(1)


class HTMLImportError(Exception):
    def __init__(self, status, message):
        self.status = status
        super().__init__(message)


def renderer_tools():
    node = shutil.which('node') or next((p for p in ['/opt/homebrew/bin/node', '/usr/local/bin/node'] if Path(p).is_file()), None)
    candidates = [os.environ.get('FIGURE_CHROME_PATH', ''),
                  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
    for directory in [os.environ.get('PROGRAMFILES', ''), os.environ.get('PROGRAMFILES(X86)', ''), os.environ.get('LOCALAPPDATA', '')]:
        if directory:
            candidates += [str(Path(directory) / 'Google/Chrome/Application/chrome.exe'), str(Path(directory) / 'Microsoft/Edge/Application/msedge.exe')]
    candidates += [shutil.which(name) for name in ['google-chrome', 'chromium', 'chromium-browser', 'msedge']]
    chrome = next((p for p in candidates if p and Path(p).is_file()), None)
    return node, chrome


def safe_member(name):
    return (isinstance(name, str) and 0 < len(name) <= 1024 and not name.startswith('/')
            and not re.match(r'^[A-Za-z]:', name) and '\\' not in name
            and not any(ord(c) < 32 for c in name)
            and all(p not in {'', '.', '..'} for p in name.split('/')))


def read_package(value):
    if not isinstance(value, dict) or set(value) - {'name', 'data', 'width', 'target', 'dpi', 'frozen'}:
        raise HTMLImportError(400, 'Send an HTML or ZIP file and optional capture settings.')
    name, encoded = value.get('name'), value.get('data')
    if not isinstance(name, str) or not name or len(name) > 300 or '/' in name or '\\' in name:
        raise HTMLImportError(400, 'Choose an HTML or ZIP file with a valid name.')
    suffix = Path(name).suffix.lower()
    if suffix not in {'.html', '.htm', '.zip'}:
        raise HTMLImportError(400, 'Choose an .html, .htm or .zip file.')
    if not isinstance(encoded, str) or len(encoded) > 4 * ((MAX_HTML_BYTES + 2) // 3):
        raise HTMLImportError(413, 'HTML and ZIP files must be at most 25 MB.')
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error):
        raise HTMLImportError(400, 'The file has invalid base64 data.')
    if not raw or len(raw) > MAX_HTML_BYTES:
        raise HTMLImportError(413, 'Choose a nonempty file of at most 25 MB.')
    files = {}
    if suffix == '.zip':
        try:
            with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                members = archive.infolist()
                if len(members) > 512 or sum(m.file_size for m in members) > MAX_EXPANDED:
                    raise HTMLImportError(413, 'ZIP contents exceed 512 entries or 100 MB expanded.')
                total = 0
                for member in members:
                    path = member.filename.rstrip('/') if member.is_dir() else member.filename
                    if not safe_member(path) or stat.S_ISLNK(member.external_attr >> 16) or member.flag_bits & 1:
                        raise HTMLImportError(422, 'ZIP contains an unsafe path, symbolic link or encrypted file.')
                    if member.is_dir():
                        continue
                    if path in files:
                        raise HTMLImportError(422, 'ZIP contains duplicate file paths.')
                    if member.file_size > MAX_HTML_BYTES:
                        raise HTMLImportError(413, 'Each ZIP member must be at most 25 MB.')
                    with archive.open(member) as stream:
                        data = stream.read(MAX_HTML_BYTES + 1)
                    total += len(data)
                    if len(data) > MAX_HTML_BYTES or total > MAX_EXPANDED:
                        raise HTMLImportError(413, 'ZIP expanded data exceeds the import limit.')
                    files[path] = data
        except (zipfile.BadZipFile, RuntimeError, NotImplementedError, OSError, EOFError) as error:
            raise HTMLImportError(422, 'Choose a readable, unencrypted ZIP archive.') from error
    else:
        files[name] = raw
    documents = []
    for path, data in files.items():
        if PurePosixPath(path).suffix.lower() not in {'.html', '.htm'} or path.startswith('__MACOSX/'):
            continue
        try:
            source = data.decode('utf-8-sig')
        except UnicodeDecodeError:
            raise HTMLImportError(422, f'{path}: HTML must use UTF-8 encoding.')
        if not re.search(r'<(?:!doctype|html|head|body|div|figure|svg|script|style)\b', source, re.I):
            raise HTMLImportError(422, f'{path}: No HTML document found.')
        documents.append(path)
    if not documents or len(documents) > 32:
        raise HTMLImportError(422, 'Choose a package containing 1–32 HTML pages.')
    width = value.get('width', 1440)
    dpi = value.get('dpi', 300)
    target = value.get('target')
    frozen = value.get('frozen', False)
    if type(frozen) is not bool or (frozen and (suffix == '.zip' or target is None)):
        raise HTMLImportError(400, 'An edited Figure must be a single HTML document with a capture target.')
    if type(width) is not int or not 320 <= width <= 2400 or type(dpi) is not int or dpi not in {150, 300, 600}:
        raise HTMLImportError(400, 'Use a page width of 320–2400 px and a resolution of 150, 300 or 600 DPI.')
    if target is not None and (not isinstance(target, dict) or set(target) != {'page', 'figure'}
            or not isinstance(target['page'], str) or len(target['page']) > 1200
            or type(target['figure']) is not int or not -1 <= target['figure'] < 100):
        raise HTMLImportError(400, 'Choose a figure or page from the import preview.')
    return {'files': {path: {'data': base64.b64encode(data).decode(), 'mime': mimetypes.guess_type(path)[0] or 'application/octet-stream'} for path, data in files.items()},
            'documents': sorted(documents), 'width': width, 'dpi': dpi, 'target': target, 'frozen': frozen,
            'source': {'name': name, 'sha256': hashlib.sha256(raw).hexdigest(), 'mime': 'application/zip' if suffix == '.zip' else 'text/html'}}


def import_html(value):
    package = read_package(value)
    node, chrome = renderer_tools()
    if not node or not chrome:
        raise HTMLImportError(503, 'HTML figure import needs Node.js and Chrome, Chromium or Edge on this computer. Install them, restart the editor, and try again.')
    if not RENDER_LOCK.acquire(blocking=False):
        raise HTMLImportError(409, 'Another HTML import is rendering. Wait for it to finish, then try again.')
    try:
        # The input is never written beneath the served editor directory.
        with tempfile.TemporaryDirectory(prefix='figure-html-render-') as directory:
            destination = Path(directory) / 'result.json'
            try:
                result = subprocess.run([node, str(Path(__file__).with_name('html-render.js')), chrome, directory, str(destination)],
                                        input=json.dumps(package).encode(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=110)
            except (OSError, subprocess.TimeoutExpired) as error:
                raise HTMLImportError(422, 'HTML rendering timed out or could not start. Try a smaller page or package.') from error
            if result.returncode or not destination.is_file():
                message = result.stderr.decode(errors='replace').strip().splitlines()
                raise HTMLImportError(422, (message[-1] if message else 'Could not render this HTML.')[:500])
            if destination.stat().st_size > 55 * 1024 * 1024:
                raise HTMLImportError(413, 'Rendered figures exceed the output size limit. Import fewer figures.')
            response = json.loads(destination.read_text())
            response['source'] = package['source']
            return response
    finally:
        RENDER_LOCK.release()
