"""Render a passive OOXML presentation with local PowerPoint for Mac."""
import base64
import io
import os
from pathlib import Path
import posixpath
import re
import subprocess
import sys
import tempfile
import threading
import uuid
import zipfile

from pptx_import import MAX_PPTX_BYTES, Package, PptxImportError, NS, RID, children

_OSASCRIPT = Path("/usr/bin/osascript")
_POWERPOINT = Path("/Applications/Microsoft PowerPoint.app/Contents/MacOS/Microsoft PowerPoint")
_POWERPOINT_TEMP = Path.home() / "Library/Containers/com.microsoft.Powerpoint/Data/tmp"
_SCRIPT = Path(__file__).parent / "scripts" / "powerpoint_pdf.applescript"
_LOCK = threading.Lock()
_OFFICE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/"
_OPC = "http://schemas.openxmlformats.org/package/2006/"
_PRESENTATION_TYPE = "application/vnd.openxmlformats-officedocument.presentationml."
_PASSIVE_RELATIONS = {
    _OFFICE + name for name in (
        "officeDocument", "extended-properties", "custom-properties", "slide", "slideLayout",
        "slideMaster", "notesSlide", "notesMaster", "handoutMaster", "theme", "tableStyles",
        "presProps", "viewProps", "commentAuthors", "comments", "image",
    )
} | {_OPC + "relationships/metadata/core-properties", _OPC + "relationships/metadata/thumbnail"}
_PRESENTATION_PARTS = {
    "presentation": "presentation.main", "slides/slide": "slide", "slideMasters/slideMaster": "slideMaster",
    "slideLayouts/slideLayout": "slideLayout", "notesMasters/notesMaster": "notesMaster",
    "notesSlides/notesSlide": "notesSlide", "handoutMasters/handoutMaster": "handoutMaster",
    "comments/comment": "comments", "commentAuthors": "commentAuthors", "tableStyles": "tableStyles",
    "presProps": "presProps", "viewProps": "viewProps",
}
_METADATA_TYPES = {
    "docProps/core.xml": "application/vnd.openxmlformats-package.core-properties+xml",
    "docProps/app.xml": "application/vnd.openxmlformats-officedocument.extended-properties+xml",
    "docProps/custom.xml": "application/vnd.openxmlformats-officedocument.custom-properties+xml",
}
_UNSAFE = ("PowerPoint PDF export requires a self-contained .pptx with standard slide objects "
           "and PNG or JPEG images. External links, active content and other embedded files are unsupported.")


def power_point_pdf_available():
    # Checking capability must never start PowerPoint or ask for Automation access.
    return (sys.platform == "darwin" and all(path.is_file() for path in (_POWERPOINT, _OSASCRIPT, _SCRIPT))
            and _POWERPOINT_TEMP.is_dir() and os.access(_POWERPOINT_TEMP, os.W_OK | os.X_OK))


def _expected_type(path):
    if path.endswith(".rels"):
        return "application/vnd.openxmlformats-package.relationships+xml"
    if path in _METADATA_TYPES:
        return _METADATA_TYPES[path]
    if re.fullmatch(r"ppt/theme/theme\d+\.xml", path):
        return "application/vnd.openxmlformats-officedocument.theme+xml"
    if re.fullmatch(r"(?:ppt/media/image\d+|docProps/thumbnail)\.(png|jpe?g)", path, re.I):
        return "image/png" if path.lower().endswith(".png") else "image/jpeg"
    if path.startswith("ppt/") and path.endswith(".xml"):
        kind = _PRESENTATION_PARTS.get(re.sub(r"\d+$", "", path[4:-4]))
        if kind:
            return _PRESENTATION_TYPE + kind + "+xml"
    raise PptxImportError(422, _UNSAFE)


def _passive_rels(package, path, root):
    directory, name = posixpath.split(path)
    if (posixpath.basename(directory) != "_rels" or root.tag != "{" + _OPC + "relationships}Relationships"):
        raise PptxImportError(422, _UNSAFE)
    owner = posixpath.join(posixpath.dirname(directory), name[:-5])
    if owner and owner not in package.names:
        raise PptxImportError(422, _UNSAFE)
    ids = set()
    for rel in root:
        target = rel.get("Target", "")
        if (rel.tag != "{" + _OPC + "relationships}Relationship" or rel.get("Type") not in _PASSIVE_RELATIONS
                or rel.get("TargetMode", "Internal") != "Internal" or not rel.get("Id") or rel.get("Id") in ids
                or not re.fullmatch(r"[A-Za-z0-9_./-]+", target) or target.startswith("//")):
            raise PptxImportError(422, _UNSAFE)
        ids.add(rel.get("Id"))
        resolved = posixpath.normpath(target[1:] if target.startswith("/") else posixpath.join(posixpath.dirname(owner), target))
        if resolved not in package.names:
            raise PptxImportError(422, _UNSAFE)


def _passive_package(raw):
    # Repack only inspected parts, with simple filenames and fresh ZIP headers.
    package = Package(raw)
    try:
        manifest = package.xml("[Content_Types].xml")
        if manifest.tag != "{" + _OPC + "content-types}Types":
            raise PptxImportError(422, _UNSAFE)
        defaults, overrides = {}, {}
        for entry in manifest:
            if entry.tag == "{" + _OPC + "content-types}Default":
                table, key = defaults, entry.get("Extension", "").lower()
            elif entry.tag == "{" + _OPC + "content-types}Override":
                table, key = overrides, entry.get("PartName", "")[1:]
                if "/" + key != entry.get("PartName") or key not in package.names:
                    raise PptxImportError(422, _UNSAFE)
            else:
                raise PptxImportError(422, _UNSAFE)
            if not key or key in table:
                raise PptxImportError(422, _UNSAFE)
            table[key] = entry.get("ContentType")
        buff = io.BytesIO()
        presentation = "ppt/presentation.xml"
        if package.related("", "officeDocument") != presentation:
            raise PptxImportError(422, _UNSAFE)
        slides = children(package.xml(presentation), "p:sldIdLst/p:sldId")
        rels = package.relationships(presentation)
        if not 1 <= len(slides) <= 500 or any(rels.get(s.get(RID + "id"), (None, None))[1] != _OFFICE + "slide" for s in slides):
            raise PptxImportError(422, "Choose a presentation with 1–500 slides.")
        with zipfile.ZipFile(buff, "w", compression=zipfile.ZIP_DEFLATED) as output:
            for path in sorted(package.names):
                if path != "[Content_Types].xml":
                    expected = _expected_type(path)
                    if overrides.get(path, defaults.get(path.rsplit(".", 1)[-1].lower())) != expected:
                        raise PptxImportError(422, _UNSAFE)
                    if path.endswith((".xml", ".rels")):
                        root = package.xml(path)
                        if path.endswith(".rels"):
                            _passive_rels(package, path, root)
                        elif any(node.tag.rsplit("}", 1)[-1] in
                                 {"oleObj", "control", "externalData", "webVideoPr", "snd", "videoFile", "audioFile", "hlinkClick", "hlinkHover"}
                                 or "action" in node.attrib or RID + "link" in node.attrib for node in root.iter()):
                            raise PptxImportError(422, _UNSAFE)
                        if root.tag == "{" + NS["p"] + "}sld" and root.get("show") in ("0", "false"):
                            raise PptxImportError(422, "PowerPoint PDF export requires all slides to be visible.")
                data = package.read(path)
                if path.lower().endswith((".png", ".jpg", ".jpeg")):
                    signature = b"\x89PNG\r\n\x1a\n" if path.lower().endswith(".png") else b"\xff\xd8\xff"
                    if not data.startswith(signature):
                        raise PptxImportError(422, _UNSAFE)
                output.writestr(path, data)
                package.xml_cache.pop(path, None)
        return buff.getvalue()
    finally:
        package.zip.close()


def render_powerpoint_pdf(payload):
    if not isinstance(payload, dict) or set(payload) != {"name", "data"}:
        raise PptxImportError(400, "Send one PPTX filename and its base64 data.")
    name, encoded = payload["name"], payload["data"]
    if (not isinstance(name, str) or len(name) > 250 or not name.lower().endswith(".pptx")
            or "/" in name or "\\" in name or not isinstance(encoded, str)):
        raise PptxImportError(400, "Choose a .pptx presentation.")
    if len(encoded) > 4 * ((MAX_PPTX_BYTES + 2) // 3):
        raise PptxImportError(413, "PPTX files must be 100 MB or smaller.")
    if not power_point_pdf_available():
        raise PptxImportError(503, "PowerPoint PDF export requires PowerPoint for Mac in /Applications. Open it once to initialize its temporary folder.")
    if not _LOCK.acquire(blocking=False):
        raise PptxImportError(409, "Another PowerPoint PDF export is already running.")
    try:
        try:
            raw = base64.b64decode(encoded, validate=True)
        except ValueError:
            raise PptxImportError(400, "The PPTX data is not valid base64.") from None
        if not 0 < len(raw) <= MAX_PPTX_BYTES:
            raise PptxImportError(413, "Choose a nonempty PPTX file of 100 MB or less.")
        # Outside its own container PowerPoint asks for a permanent folder grant.
        with tempfile.TemporaryDirectory(prefix="figure-powerpoint-", dir=_POWERPOINT_TEMP) as folder:
            # PowerPoint references presentations by basename, even across folders.
            source = Path(folder) / ("FE-" + uuid.uuid4().hex + ".pptx")
            pdf = source.with_suffix(".pdf")
            source.write_bytes(_passive_package(raw))
            try:
                subprocess.run([str(_OSASCRIPT), str(_SCRIPT), str(source), str(pdf), source.name],
                               check=True, capture_output=True, timeout=110)
            except subprocess.TimeoutExpired:
                raise PptxImportError(504, "PowerPoint timed out. Finish any open PowerPoint dialog and try again.") from None
            except subprocess.CalledProcessError:
                raise PptxImportError(503, "PowerPoint could not export the presentation. Check macOS Automation permission and any open PowerPoint dialog.") from None
            if not pdf.is_file() or not 0 < pdf.stat().st_size <= MAX_PPTX_BYTES:
                raise PptxImportError(422, "PowerPoint did not return a PDF within the 100 MB limit.")
            data = pdf.read_bytes()
            if not data.startswith(b"%PDF-"):
                raise PptxImportError(422, "PowerPoint returned an invalid PDF.")
            return {"data": base64.b64encode(data).decode("ascii")}
    except OSError:
        raise PptxImportError(503, "The local PowerPoint PDF export could not finish.") from None
    finally:
        _LOCK.release()
