#!/bin/sh
# macOS: double-click to open this local Figure Editor.
set -eu
cd -- "$(dirname -- "$0")"

if ! command -v python3 >/dev/null 2>&1; then
  printf '%s\n' 'Python 3 is required. Install it, then double-click start.command again.'
  exit 1
fi

exec python3 -u - <<'PY'
import errno
import json
import pathlib
import subprocess
import sys
import urllib.error
import urllib.request

root = pathlib.Path.cwd().resolve()
url = "http://127.0.0.1:8766/"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


opener = urllib.request.build_opener(
    urllib.request.ProxyHandler({}), NoRedirect()
)


def served_files_match():
    """Require the running service to serve this exact local app."""
    try:
        for name in ("index.html", "app.js"):
            expected = (root / name).read_bytes()
            request = urllib.request.Request(url + name, headers={"Cache-Control": "no-cache"})
            with opener.open(request, timeout=2) as response:
                if response.status != 200 or response.read(len(expected) + 1) != expected:
                    return False
        return True
    except (OSError, urllib.error.URLError):
        return False


def has_local_backend():
    """A plain static server cannot provide local file operations."""
    try:
        request = urllib.request.Request(url + "api/local", headers={"Cache-Control": "no-cache"})
        with opener.open(request, timeout=2) as response:
            payload = response.read(4097)
            if response.status != 200 or len(payload) > 4096:
                return False
        identity = json.loads(payload)
        return (
            isinstance(identity, dict)
            and identity.get("app") == "figure-editor-local"
            and type(identity.get("version")) is int
            and identity["version"] == 1
            and isinstance(identity.get("locate"), bool)
            and isinstance(identity.get("token"), str)
            and bool(identity["token"])
        )
    except (OSError, urllib.error.URLError, ValueError, UnicodeError):
        return False


def open_browser():
    try:
        subprocess.run(["/usr/bin/open", url], check=True)
    except (OSError, subprocess.CalledProcessError):
        print("Could not open the browser. Open this URL manually: " + url)


if not all((root / name).is_file() for name in ("index.html", "app.js", "server.py")):
    sys.exit("App files are missing. Keep start.command inside the editable folder.")

from server import create_server

matching_files = served_files_match()
if matching_files and has_local_backend():
    print("Verified the existing Figure Editor server. Reusing: " + url)
    open_browser()
    sys.exit(0)

try:
    server = create_server(root, port=8766)
except OSError as error:
    if error.errno == errno.EADDRINUSE:
        if matching_files:
            sys.exit("Port 8766 is serving these Figure Editor files without the required local backend. Close the old Figure Editor Terminal window, then double-click start.command again. No server was started or stopped.")
        sys.exit("Port 8766 is in use, and the existing service could not be verified as this Figure Editor. No server was started or stopped.")
    sys.exit("Could not start the local server: " + str(error))

print("Figure Editor is running at: " + url)
print("Keep this Terminal window open. Press Ctrl + C to stop the server.")
open_browser()
try:
    server.serve_forever()
except KeyboardInterrupt:
    print("\nThe Figure Editor local server has stopped.")
finally:
    server.server_close()
PY
