#!/usr/bin/env python3
"""Dependency-free, local stdio MCP adapter for the live Figure Editor."""
import argparse
import base64
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import sys
import urllib.error
import urllib.request


def obj(properties, required=()):
    return {"type": "object", "properties": properties, "required": list(required), "additionalProperties": False}


STRING = {"type": "string", "minLength": 1, "maxLength": 300}
NUMBER = {"type": "number"}
POSITIVE_NUMBER = {**NUMBER, "exclusiveMinimum": 0}
EXPORT_FORMAT = {"enum": ["png", "svg", "pdf", "pptx", "html"]}
PREVIEW_SIZE = {"type": "integer", "minimum": 256, "maximum": 1600}
SESSION = {"sessionId": STRING}
REVISION = {**SESSION, "expectedRevision": STRING}
ASSET_PATH = {"type": "string", "minLength": 1, "maxLength": 2000}
IMAGE_MIMES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml"}
MAX_IMPORT_BYTES = 24 * 1024 * 1024
MAX_CHECK_BYTES = 256 * 1024 * 1024
PLACEMENT_FIELDS = {**{key: NUMBER for key in ("x", "y", "width", "height", "rotation", "opacity")},
                    "name": {"type": "string", "maxLength": 20000}}
PROPERTIES = obj({**PLACEMENT_FIELDS, "fontSize": NUMBER,
                  **{key: {"type": "string", "maxLength": 20000} for key in ("text", "fontFamily", "fontStyle", "color", "align")},
                  "fontWeight": {"enum": [400, 700, "400", "700"]}})
TARGETS = {"slideId": STRING, "itemIds": {"type": "array", "items": STRING, "minItems": 1, "maxItems": 2000}}
SVG_VALUE = {"type": "string", "maxLength": 20000}
SVG_ATTRIBUTES = {**obj({key: SVG_VALUE for key in (
    "viewBox", "transform", "opacity", "fill", "stroke", "filter", "d", "x", "y", "width", "height", "rx", "ry",
    "cx", "cy", "r", "x1", "y1", "x2", "y2", "points", "font-size", "font-family", "text-anchor", "dx", "dy",
    "gradientTransform", "gradientUnits", "spreadMethod", "fx", "fy", "fr", "offset", "stop-color", "stop-opacity",
    "filterUnits", "primitiveUnits", "stdDeviation", "flood-color", "flood-opacity", "type", "values", "operator",
    "k1", "k2", "k3", "k4", "mode", "stroke-width", "fill-opacity", "stroke-opacity"
)}), "minProperties": 1}
SVG_PATH = {"type": "array", "items": {"type": "integer", "minimum": 0}, "maxItems": 128}
SVG_TEXT = {"textIndex": {"type": "integer", "minimum": 0}, "text": SVG_VALUE}
SVG_PATCH = {"oneOf": [
    obj({"path": SVG_PATH, "attributes": SVG_ATTRIBUTES}, ["path", "attributes"]),
    obj({"path": SVG_PATH, **SVG_TEXT}, ["path", *SVG_TEXT]),
    obj({"path": SVG_PATH, "attributes": SVG_ATTRIBUTES, **SVG_TEXT}, ["path", "attributes", *SVG_TEXT]),
]}
OPERATIONS = {"oneOf": [
    obj({"op": {"const": "set"}, **TARGETS, "properties": PROPERTIES}, ["op", "slideId", "itemIds", "properties"]),
    obj({"op": {"const": "align"}, **TARGETS, "alignment": {"enum": ["left", "center", "right", "top", "middle", "bottom"]}}, ["op", "slideId", "itemIds", "alignment"]),
    obj({"op": {"const": "distribute"}, **TARGETS, "axis": {"enum": ["x", "y"]}, "gap": {"type": "number", "minimum": 0, "maximum": 100000}}, ["op", "slideId", "itemIds", "axis"]),
    obj({"op": {"const": "add_text"}, "slideId": STRING, "properties": PROPERTIES}, ["op", "slideId", "properties"]),
    obj({"op": {"const": "place_asset"}, "slideId": STRING, "assetId": STRING, "properties": obj(PLACEMENT_FIELDS)}, ["op", "slideId", "assetId"]),
    obj({"op": {"const": "swap_asset"}, "slideId": STRING, "itemId": STRING, "assetId": STRING}, ["op", "slideId", "itemId", "assetId"]),
    obj({"op": {"const": "duplicate"}, **TARGETS, "offsetX": NUMBER, "offsetY": NUMBER}, ["op", "slideId", "itemIds"]),
    obj({"op": {"const": "delete"}, **TARGETS}, ["op", "slideId", "itemIds"]),
    obj({"op": {"const": "reorder"}, **TARGETS, "direction": {"enum": ["front", "back", "forward", "backward"]}}, ["op", "slideId", "itemIds", "direction"]),
    obj({"op": {"const": "set_hidden"}, **TARGETS, "hidden": {"type": "boolean"}}, ["op", "slideId", "itemIds", "hidden"]),
    obj({"op": {"const": "set_locked"}, **TARGETS, "locked": {"type": "boolean"}}, ["op", "slideId", "itemIds", "locked"]),
    obj({"op": {"const": "replace_asset"}, **TARGETS, "assetId": STRING}, ["op", "slideId", "itemIds", "assetId"]),
    obj({"op": {"const": "edit_svg"}, "slideId": STRING, "itemId": STRING, "assetId": STRING,
         "patches": {"type": "array", "items": SVG_PATCH, "minItems": 1, "maxItems": 200}}, ["op", "slideId", "itemId", "assetId", "patches"]),
]}
BATCH_OPERATIONS = {"type": "array", "items": OPERATIONS, "minItems": 1, "maxItems": 200}


def tool(name, description, schema, readonly=False):
    return {"name": "figure_" + name, "description": description, "inputSchema": schema,
            "annotations": {"readOnlyHint": readonly, "destructiveHint": False, "openWorldHint": False}}


TOOLS = [
    tool("sessions", "List connected editor pages. Choose the exact session; never guess when multiple pages are open. Summary may lag; get_state reads live state.", obj({}), True),
    tool("get_state", "Read live project/slide/object IDs, geometry, text, selection, revision, busy and save status. "
         "Assets are metadata only. Each asset's usedBy lists its placements across all slides. "
         "Use relativePath and fingerprint when available to identify the source. Defaults to the active slide. Pass slideId to inspect another slide.",
         obj({**SESSION, "slideId": STRING}, SESSION), True),
    tool("import_assets", "Import 1–32 explicit PNG, JPEG or SVG paths relative to the adapter's configured --asset-root "
         "(24 MiB total). Returns asset IDs and content fingerprints. Identical content at the same path is reused; "
         "changed content creates a new library asset. Use place_asset or swap_asset to use it on a slide.",
         obj({**REVISION, "paths": {"type": "array", "items": ASSET_PATH, "minItems": 1, "maxItems": 32}}, [*REVISION, "paths"])),
    tool("check_sources", "Compare recorded fingerprints with readable source files and list affected slide/object IDs. "
         "Checks the project or selected assetIds. Reports embedded copies, missing files, and unavailable permissions separately. "
         "Use a smaller selection if the read budget is reached.",
         obj({**SESSION, "assetIds": {"type": "array", "items": STRING, "minItems": 1, "maxItems": 500}}, SESSION), True),
    tool("inspect_svg", "Read editable SVG elements for one image placement, including child-index paths, editableAttributes, "
         "attribute values and direct text segments. Returns revision and assetId for edit_svg. "
         "Paginate with offset/limit (default 50, maximum 100 nodes). Values truncate at 2000 characters; "
         "at most 20 text segments per node are shown, with counts/truncation flags. Shared gradients/filters "
         "affect their references inside this SVG. Outlined text is paths, not editable text.",
         obj({**SESSION, "slideId": STRING, "itemId": STRING, "offset": {"type": "integer", "minimum": 0},
              "limit": {"type": "integer", "minimum": 1, "maximum": 100}}, [*SESSION, "slideId", "itemId"]), True),
    tool("batch_edit", "Apply 1–200 operations atomically as one Undo step. Use the revision from get_state. "
         "place_asset adds a slide object linked to a project asset. Use an assetId from get_state.assets. "
         "Omit properties for the editor's Place defaults. Set only width or height to preserve media proportions, or both to stretch. Geometry uses CSS px. "
         "swap_asset replaces one unlocked image object's source with an existing project SVG or raster image. "
         "Specify slideId, itemId and the replacement assetId. The replacement resets the crop and fits proportionally inside the same frame, centered. "
         "The object keeps its rotation and layer order. Library assets and other placements are unaffected. "
         "duplicate copies objects in layer order (default offset 20 px each axis) and returns duplicatedItems mappings. "
         "delete removes placements only. reorder moves selected objects front/back or one step forward/backward, preserving their relative order. "
         "set_hidden and set_locked take booleans. Only set_locked can target locked objects; explicitly unlock before editing. "
         "replace_asset updates explicit itemIds to an imported assetId, preserving crop, imageFit, geometry and styling exactly. "
         "Use import_assets first for changed source files; use usedBy to select placements across slides. "
         "Aspect changes return warnings; an unchanged crop may show different content in a revised plot. "
         "edit_svg requires the current assetId and paths from inspect_svg. Patches change whitelisted attributes or a direct "
         "textIndex/text segment without changing the tree. It creates a derived asset for only that placement, preserving other copies. "
         "Locked objects reject the entire batch. Align/distribute use unrotated object boxes. An explicit gap anchors the first object. Omit gap to preserve the outer span.",
         obj({**REVISION, "operations": BATCH_OPERATIONS}, [*REVISION, "operations"])),
    tool("duplicate_slide", "Copy the specified slide immediately after its source and select the copy, in one Undo step. "
         "Pass the current revision and optional name. Use newSlideId and itemIdMap[originalItemId] to edit an object on the copy. The slides share library assets.",
         obj({**REVISION, "slideId": STRING, "name": {**STRING, "pattern": r"\S"}}, [*REVISION, "slideId"])),
    tool("preview", "Render a PNG preview of the selected slide from a fixed document snapshot. Returns an image plus renderedRevision. HTML charts use their saved snapshots, videos use posters.", obj({**SESSION, "slideId": STRING, "maxSize": PREVIEW_SIZE}, SESSION), True),
    tool("preview_batch", "Try batch_edit operations on a copy of the current revision. Return a PNG of one slide with proposed=true. "
         "Defaults to the active slide. To apply the edits, call batch_edit with the same operations and expectedRevision.",
         obj({**REVISION, "operations": BATCH_OPERATIONS, "slideId": STRING, "maxSize": PREVIEW_SIZE}, [*REVISION, "operations"]), True),
    tool("check_export", "Check effective raster DPI, objects outside the canvas and HTML charts missing snapshots. "
         "finalWidthMm is the intended width of the whole output page. minRasterDpi defaults to 300. "
         "Inspect one slide by ID, otherwise PNG/SVG/PDF check the active slide and PPTX/HTML check all slides. "
         "Returns object-level findings and measurements without writing an export.",
         obj({**SESSION, "format": EXPORT_FORMAT, "slideId": STRING, "finalWidthMm": POSITIVE_NUMBER,
              "minRasterDpi": {**POSITIVE_NUMBER, "default": 300}}, [*SESSION, "format"]), True),
    tool("export", "Export through existing renderers to a NEW file in the configured local output directory (never overwrites). PNG/SVG/PDF export one slide; PPTX/HTML export all slides and reject slideId. PDF text needs the macOS outlining service. Bridge limit: 24 MiB. Returns absolute path, bytes and SHA-256. Does not save the editable project.", obj({**SESSION, "format": EXPORT_FORMAT, "slideId": STRING, "dpi": {"enum": [150, 300, 600]}}, [*SESSION, "format"])),
    tool("history", "Undo or redo ONE existing editor history entry. Requires current revision. Read state after an uncertain/timeout result before considering another action.", obj({**REVISION, "action": {"enum": ["undo", "redo"]}}, [*REVISION, "action"])),
    tool("save", "Save the current editable project using existing persistence. destination=file writes only to an already authorized file, with external-change checks; if unavailable, click Save in the page once. destination=draft stores browser recovery only, not a disk project. Preserves AutoSave preference.", obj({**REVISION, "destination": {"enum": ["file", "draft"]}}, [*REVISION, "destination"])),
]


def validate(value, schema, path="arguments"):
    """Validate the deliberately small JSON Schema vocabulary used above."""
    if "oneOf" in schema:
        count = 0
        for branch in schema["oneOf"]:
            try:
                validate(value, branch, path)
                count += 1
            except ValueError:
                pass
        if count != 1:
            raise ValueError(path + " does not match a supported operation.")
        return
    if "const" in schema and value != schema["const"] or "enum" in schema and value not in schema["enum"]:
        raise ValueError(path + " has an unsupported value.")
    kind = schema.get("type")
    valid = {"object": isinstance(value, dict), "array": isinstance(value, list), "string": isinstance(value, str),
             "number": type(value) in (int, float), "integer": type(value) is int, "boolean": type(value) is bool}
    if kind and not valid[kind]:
        raise ValueError(path + " must be " + kind + ".")
    if kind == "object":
        if len(value) < schema.get("minProperties", 0):
            raise ValueError(path + " must contain at least one field.")
        if set(schema.get("required", [])) - set(value):
            raise ValueError(path + " is missing required fields.")
        if set(value) - set(schema["properties"]):
            raise ValueError(path + " contains unsupported fields.")
        for key, child in value.items():
            validate(child, schema["properties"][key], path + "." + key)
    elif kind in {"string", "array"}:
        lower, upper = ("minLength", "maxLength") if kind == "string" else ("minItems", "maxItems")
        if len(value) < schema.get(lower, 0) or len(value) > schema.get(upper, float("inf")):
            raise ValueError(path + " has an invalid length.")
        if kind == "string" and "pattern" in schema and not re.search(schema["pattern"], value):
            raise ValueError(path + " must contain a non-whitespace character.")
        if kind == "array":
            for child in value:
                validate(child, schema["items"], path + "[]")
    elif kind in {"number", "integer"}:
        if (not -sys.float_info.max <= value <= sys.float_info.max
                or not schema.get("minimum", float("-inf")) <= value <= schema.get("maximum", float("inf"))
                or value <= schema.get("exclusiveMinimum", float("-inf"))):
            raise ValueError(path + " is outside the allowed range.")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError("The local editor must not redirect MCP requests.")


def image_path_parts(path):
    if (not isinstance(path, str) or not 0 < len(path) <= ASSET_PATH["maxLength"] or path != path.strip()
            or re.search(r"[\\\x00-\x1f\x7f]|%(?:25|2e|2f|3a|5c)", path, re.I)
            or re.match(r"^(?:[a-z][a-z0-9+.-]*:|~)", path, re.I)):
        raise ValueError("Specify a relative image path inside --asset-root.")
    parts = path.split("/")
    if any(not part or part.startswith(".") for part in parts):
        raise ValueError("Specify a relative image path without hidden or traversal components.")
    if Path(parts[-1]).suffix.lower() not in IMAGE_MIMES:
        raise ValueError("Only PNG, JPEG and SVG image paths are supported.")
    return parts


class AssetRoot:
    def __init__(self, directory):
        if os.open not in os.supports_dir_fd or not hasattr(os, "O_NOFOLLOW"):
            raise ValueError("This platform lacks the safe directory reads required for --asset-root.")
        self.path = Path(directory).expanduser().resolve(strict=True)
        info = self.path.stat()
        if not stat.S_ISDIR(info.st_mode):
            raise ValueError("--asset-root must be an existing directory.")
        self.identity = (info.st_dev, info.st_ino)
        self.id = hashlib.sha256(os.fsencode(self.path) + f"\0{info.st_dev}:{info.st_ino}".encode()).hexdigest()

    def read(self, relative_path, budget):
        parts = image_path_parts(relative_path)
        directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        with ExitStack() as handles:
            try:
                directory = os.open(self.path, directory_flags)
            except OSError as error:
                raise ValueError("The configured asset root is unavailable.") from error
            handles.callback(os.close, directory)
            info = os.fstat(directory)
            if (info.st_dev, info.st_ino) != self.identity:
                raise ValueError("The configured asset root has been replaced. Reload the adapter.")
            for part in parts[:-1]:
                directory = os.open(part, directory_flags, dir_fd=directory)
                handles.callback(os.close, directory)
            fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
            handles.callback(os.close, fd)
            before = os.fstat(fd)
            if not stat.S_ISREG(before.st_mode):
                raise ValueError("Source must be a regular image file.")
            budget.reserve(before.st_size)
            stream = handles.enter_context(os.fdopen(fd, "rb", closefd=False))
            data = stream.read(before.st_size + 1)
            # Analysis scripts often write a temporary file and replace the source path atomically.
            after = os.stat(parts[-1], dir_fd=directory, follow_symlinks=False)
            if (not os.path.samestat(before, after) or len(data) != before.st_size or after.st_size != before.st_size
                    or after.st_mtime_ns != before.st_mtime_ns or after.st_ctime_ns != before.st_ctime_ns):
                raise ValueError("The source changed while being read. Try again after it finishes writing.")
            return data

    def import_files(self, paths):
        if len(set(paths)) != len(paths):
            raise ValueError("Specify each import path only once.")
        files, budget = [], ReadBudget(MAX_IMPORT_BYTES)
        for path in paths:
            try:
                data = self.read(path, budget)
            except (OSError, ValueError) as error:
                reason = error.strerror if isinstance(error, OSError) else str(error)
                raise ValueError(f"Cannot import {path}: {reason}") from error
            files.append({"relativePath": path, "mime": IMAGE_MIMES[Path(path).suffix.lower()],
                          "data": base64.b64encode(data).decode("ascii"), "fingerprint": hashlib.sha256(data).hexdigest()})
        return files


class ReadBudget:
    """Charge before reading so concurrent rewrites still count toward the limit."""
    def __init__(self, limit):
        self.remaining = limit

    def reserve(self, size):
        if size > MAX_IMPORT_BYTES:
            raise ValueError("Source exceeds the 24 MiB file limit.")
        if size > self.remaining:
            raise ValueError("Source exceeds the remaining read budget. Select fewer files.")
        self.remaining -= size


def check_root_sources(report, root):
    current = {}
    budget = ReadBudget(MAX_CHECK_BYTES)
    for row in report["sources"]:
        if row["status"] != "check_root":
            continue
        root_id = row.pop("mcpRootId", None)
        if not root or root_id != root.id:
            row.update(status="unavailable", reason="Configure the original --asset-root to check this file.")
            continue
        path = row.get("relativePath")
        try:
            image_path_parts(path)
        except ValueError as error:
            row.update(status="unavailable", reason=str(error))
            continue
        if path not in current:
            try:
                raw = root.read(path, budget)
                current[path] = {"currentFingerprint": hashlib.sha256(raw).hexdigest()}
            except FileNotFoundError:
                current[path] = {"status": "missing", "reason": "The source file was not found."}
            except PermissionError:
                current[path] = {"status": "permission_required", "reason": "Read access to the source file is required."}
            except OSError:
                current[path] = {"status": "unavailable", "reason": "The source path cannot be opened safely."}
            except ValueError as error:
                current[path] = {"status": "unavailable", "reason": str(error)}
        result = current[path]
        row.update(result)
        if "currentFingerprint" in result:
            stored = row.get("fingerprint")
            if not isinstance(stored, str) or not re.fullmatch(r"(?:sha256:)?[a-f0-9]{64}", stored, re.I):
                row["status"] = "no_fingerprint"
            else:
                row["status"] = "unchanged" if result["currentFingerprint"] == stored.lower().removeprefix("sha256:") else "changed"


class EditorClient:
    def __init__(self, port, output_dir, asset_root=None):
        self.origin = f"http://127.0.0.1:{port}"
        self.output_dir = Path(output_dir).expanduser().resolve()
        self.asset_root = AssetRoot(asset_root) if asset_root is not None else None
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def request(self, path, data=None, token=None):
        headers = {"Origin": self.origin, "Content-Type": "application/json"}
        if token:
            headers["X-Figure-Token"] = token
        body = json.dumps(data, allow_nan=False).encode() if data is not None else None
        request = urllib.request.Request(self.origin + path, data=body, headers=headers)
        try:
            with self.opener.open(request, timeout=50) as response:
                raw = response.read(36 * 1024 * 1024 + 1)
                if len(raw) > 36 * 1024 * 1024:
                    raise ValueError("Editor response exceeds the bridge limit.")
                return json.loads(raw)
        except urllib.error.HTTPError as error:
            try:
                message = json.loads(error.read(8192)).get("error", str(error))
            except (ValueError, AttributeError):
                message = str(error)
            raise ValueError(message) from error
        except (urllib.error.URLError, TimeoutError) as error:
            raise ValueError("Cannot reach the local Figure Editor. Start/restart server.py and open the page. If a command was already sent, its outcome may be unknown; read state before retrying.") from error

    def call(self, name, arguments):
        definition = next((item for item in TOOLS if item["name"] == name), None)
        if definition is None:
            raise ValueError("Unknown Figure Editor tool.")
        validate(arguments, definition["inputSchema"])
        info = self.request('/api/local')
        if info.get("app") != "figure-editor-local" or not info.get("automation"):
            raise ValueError("Restart the Figure Editor local server to load MCP support.")
        token = info["token"]
        if name == "figure_sessions":
            value = self.request('/api/automation/sessions', {}, token)
        else:
            params = {key: value for key, value in arguments.items() if key != "sessionId"}
            if name == "figure_import_assets":
                if not self.asset_root:
                    raise ValueError("Configure --asset-root on the Figure Editor MCP adapter before importing files.")
                params.update(rootId=self.asset_root.id, files=self.asset_root.import_files(params.pop("paths")))
            value = self.request('/api/automation/command', {"sessionId": arguments["sessionId"], "method": name.removeprefix('figure_'), "params": params}, token)
            if name == "figure_check_sources":
                check_root_sources(value, self.asset_root)
        content = []
        if name in {"figure_preview", "figure_preview_batch", "figure_export"}:
            value = dict(value)
            encoded = value.pop("data", "")
            raw = base64.b64decode(encoded, validate=True)
            if not raw or len(raw) > 24 * 1024 * 1024:
                raise ValueError("Invalid or oversized editor export.")
            if name != "figure_export":
                if name == "figure_preview_batch" and value.get("proposed") is not True:
                    raise ValueError("The editor did not identify the preview as a proposal.")
                if value.get("mimeType") != 'image/png' or not raw.startswith(b'\x89PNG\r\n\x1a\n'):
                    raise ValueError("Invalid preview image.")
                content.append({"type": "image", "data": encoded, "mimeType": "image/png"})
            else:
                extension = arguments["format"]
                self.output_dir.mkdir(parents=True, exist_ok=True)
                destination = self.output_dir / ("figure-" + secrets.token_hex(12) + "." + extension)
                with destination.open('xb') as stream:
                    stream.write(raw)
                value.update(path=str(destination), bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest())
        content.insert(0, {"type": "text", "text": json.dumps(value, ensure_ascii=False, allow_nan=False)})
        return {"content": content, "structuredContent": value, "isError": False}


class MCPServer:
    def __init__(self, client):
        self.client = client
        self.initialized = False

    def dispatch(self, message):
        if not isinstance(message, dict) or message.get('jsonrpc') != '2.0' or not isinstance(message.get('method'), str):
            return self.error(None, -32600, 'Invalid JSON-RPC request.')
        if 'id' not in message:
            return None  # initialized/cancelled notifications have no response.
        identifier = message['id']
        if type(identifier) not in (str, int):
            return self.error(None, -32600, 'Request ID must be a string or integer.')
        method, params = message['method'], message.get('params', {})
        if not isinstance(params, dict):
            return self.error(identifier, -32602, 'Parameters must be an object.')
        if method == 'initialize':
            requested = params.get('protocolVersion')
            if not isinstance(requested, str):
                return self.error(identifier, -32602, 'protocolVersion must be a string.')
            version = requested if requested in {'2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'} else '2025-11-25'
            self.initialized = True
            result = {"protocolVersion": version, "capabilities": {"tools": {"listChanged": False}},
                      "serverInfo": {"name": "figure-editor", "version": "0.1.0"},
                      "instructions": "List sessions, select the intended page, then get_state. Mutations require its exact revision. Use preview_batch to inspect a proposed edit, then batch_edit to apply it in one Undo step. Use duplicate_slide for a new slide variant. Use check_export for format-specific findings before exporting. Distinguish a browser draft from a saved project file. On timeout, inspect state before retrying. All geometry uses CSS px (96 px/inch)."}
        elif method == 'ping':
            result = {}
        elif not self.initialized:
            return self.error(identifier, -32000, 'Initialize first.')
        elif method == 'tools/list':
            result = {"tools": TOOLS}
        elif method == 'tools/call':
            try:
                result = self.client.call(params.get('name'), params.get('arguments', {}))
            except Exception as error:
                result = {"content": [{"type": "text", "text": str(error)}], "isError": True}
        else:
            return self.error(identifier, -32601, 'Method not found.')
        return {"jsonrpc": "2.0", "id": identifier, "result": result}

    @staticmethod
    def error(identifier, code, message):
        return {"jsonrpc": "2.0", "id": identifier, "error": {"code": code, "message": message}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8766)
    parser.add_argument('--output-dir', type=Path, default=Path(__file__).resolve().parent / 'output' / 'mcp')
    parser.add_argument('--asset-root', type=Path, help="Directory from which MCP may import and check SVG, PNG and JPEG files.")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error('port must be between 1 and 65535')
    try:
        server = MCPServer(EditorClient(args.port, args.output_dir, args.asset_root))
    except (ValueError, OSError) as error:
        parser.error(str(error))
    for line in sys.stdin.buffer:
        try:
            if len(line) > 1024 * 1024:
                raise ValueError('Request is too large.')
            message = json.loads(line, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
            response = server.dispatch(message)
        except (ValueError, RecursionError):
            response = server.error(None, -32700, 'Invalid JSON request.')
        if response is not None:
            print(json.dumps(response, ensure_ascii=False, allow_nan=False), flush=True)


if __name__ == '__main__':
    main()
