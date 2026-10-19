#!/usr/bin/env python3
"""Build a macOS desktop app bound to this checkout, without copying its code."""
import argparse
from pathlib import Path
import plistlib
import shlex
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
IDENTIFIER = "local.figure-editor.checkout"
APPLESCRIPT = '''on run
    try
        set launcherPath to POSIX path of (path to resource "launch.sh")
        do shell script "/bin/sh " & quoted form of launcherPath
    on error errorMessage
        display dialog errorMessage with title "Figure Editor" buttons {"OK"} default button "OK" with icon stop
    end try
end run
'''


def build(destination):
    destination = destination.expanduser().absolute()
    if destination.exists() or destination.is_symlink():
        raise SystemExit("Destination already exists; it was not changed: " + str(destination))
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="figure-editor-app-", dir=destination.parent) as temporary:
        work = Path(temporary)
        bundle = work / "Figure Editor.app"
        subprocess.run(["/usr/bin/osacompile", "-o", str(bundle), "-e", APPLESCRIPT], check=True)
        resources = bundle / "Contents" / "Resources"
        launcher = resources / "launch.sh"
        launcher.write_text(
            "#!/bin/sh\nset -eu\nunset PYTHONPATH PYTHONHOME VIRTUAL_ENV\n"
            + "cd " + shlex.quote(str(ROOT)) + "\n"
            + "exec " + shlex.join([sys.executable, "-B", str(ROOT / "scripts" / "desktop_launcher.py")]) + "\n",
            encoding="utf-8",
        )
        launcher.chmod(0o755)
        png = work / "icon.png"
        subprocess.run(["/usr/bin/swift", "-module-cache-path", str(work / "swift-cache"),
                        str(ROOT / "scripts" / "macos_icon.swift"), str(png)], check=True)
        iconset = work / "FigureEditor.iconset"
        iconset.mkdir()
        for size in (16, 32, 128, 256, 512):
            for scale in (1, 2):
                filename = "icon_{0}x{0}{1}.png".format(size, "@2x" if scale == 2 else "")
                subprocess.run(["/usr/bin/sips", "-z", str(size * scale), str(size * scale),
                                str(png), "--out", str(iconset / filename)], check=True,
                               stdout=subprocess.DEVNULL)
        subprocess.run(["/usr/bin/iconutil", "-c", "icns", str(iconset), "-o",
                        str(resources / "FigureEditor.icns")], check=True)
        shutil.copy2(png, resources / "icon-preview.png")
        info_path = bundle / "Contents" / "Info.plist"
        with info_path.open("rb") as stream:
            info = plistlib.load(stream)
        # osacompile supplies an applet icon name that can override IconFile.
        info.pop("CFBundleIconName", None)
        info.update({"CFBundleIdentifier": IDENTIFIER, "CFBundleName": "Figure Editor",
                     "CFBundleDisplayName": "Figure Editor", "CFBundleIconFile": "FigureEditor",
                     "CFBundleShortVersionString": "1.0", "CFBundleVersion": "1",
                     "LSUIElement": True, "NSHighResolutionCapable": True,
                     "FigureEditorSourceRoot": str(ROOT)})
        with info_path.open("wb") as stream:
            plistlib.dump(info, stream)
        subprocess.run(["/usr/bin/codesign", "--force", "--sign", "-", str(bundle)], check=True,
                       stdout=subprocess.DEVNULL)
        bundle.rename(destination)
    print(destination)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--destination", type=Path, default=Path.home() / "Desktop" / "Figure Editor.app")
    build(parser.parse_args().destination)
