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
import functools
import http.server
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


def is_this_editor():
    """Reuse only when both served files exactly match this local app."""
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({}), NoRedirect()
    )
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


def open_browser():
    try:
        subprocess.run(["/usr/bin/open", url], check=True)
    except (OSError, subprocess.CalledProcessError):
        print("Could not open the browser. Open this URL manually: " + url)


if not all((root / name).is_file() for name in ("index.html", "app.js")):
    sys.exit("App files are missing. Keep start.command inside the editable folder.")

if is_this_editor():
    print("Verified the existing Figure Editor server. Reusing: " + url)
    open_browser()
    sys.exit(0)

handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(root))
try:
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 8766), handler)
except OSError as error:
    if error.errno == errno.EADDRINUSE:
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
