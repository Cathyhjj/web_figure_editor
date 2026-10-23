#!/usr/bin/env python3
"""Dependency-free, local stdio MCP adapter for the live Figure Editor."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import secrets
import sys
import urllib.error
import urllib.request


def obj(properties, required=()):
    return {"type": "object", "properties": properties, "required": list(required), "additionalProperties": False}


STRING = {"type": "string", "minLength": 1, "maxLength": 300}
NUMBER = {"type": "number"}
SESSION = {"sessionId": STRING}
REVISION = {**SESSION, "expectedRevision": STRING}
PROPERTIES = obj({**{key: NUMBER for key in ("x", "y", "width", "height", "rotation", "opacity", "fontSize")},
                  **{key: {"type": "string", "maxLength": 20000} for key in ("name", "text", "fontFamily", "fontStyle", "color", "align")},
                  "fontWeight": {"enum": [400, 700, "400", "700"]}})
TARGETS = {"slideId": STRING, "itemIds": {"type": "array", "items": STRING, "minItems": 1, "maxItems": 2000}}
OPERATIONS = {"oneOf": [
    obj({"op": {"const": "set"}, **TARGETS, "properties": PROPERTIES}, ["op", "slideId", "itemIds", "properties"]),
    obj({"op": {"const": "align"}, **TARGETS, "alignment": {"enum": ["left", "center", "right", "top", "middle", "bottom"]}}, ["op", "slideId", "itemIds", "alignment"]),
    obj({"op": {"const": "distribute"}, **TARGETS, "axis": {"enum": ["x", "y"]}, "gap": {"type": "number", "minimum": 0, "maximum": 100000}}, ["op", "slideId", "itemIds", "axis"]),
    obj({"op": {"const": "add_text"}, "slideId": STRING, "properties": PROPERTIES}, ["op", "slideId", "properties"]),
]}


def tool(name, description, schema, readonly=False):
    return {"name": "figure_" + name, "description": description, "inputSchema": schema,
            "annotations": {"readOnlyHint": readonly, "destructiveHint": False, "openWorldHint": False}}


TOOLS = [
    tool("sessions", "List connected editor pages. Choose the exact session; never guess when multiple pages are open. Summary may lag; get_state reads live state.", obj({}), True),
    tool("get_state", "Read live project/slide/object IDs, geometry, text, selection, revision, busy and save status. Assets are metadata only. Defaults to active slide; pass slideId to inspect another slide.", obj({**SESSION, "slideId": STRING}, SESSION), True),
    tool("batch_edit", "Apply 1–200 operations atomically as ONE Undo step. CSS px units. Requires revision from get_state. Locked objects reject the entire batch. A single image width/height preserves ratio; setting both allows stretching. Align/distribute use unrotated object boxes. Explicit gap anchors the first object; omitted gap preserves outer span. No partial commits.", obj({**REVISION, "operations": {"type": "array", "items": OPERATIONS, "minItems": 1, "maxItems": 200}}, [*REVISION, "operations"])),
    tool("preview", "Render a PNG preview of the selected slide from a fixed document snapshot. Returns an image plus renderedRevision. HTML charts use their saved snapshots, videos use posters.", obj({**SESSION, "slideId": STRING, "maxSize": {"type": "integer", "minimum": 256, "maximum": 1600}}, SESSION), True),
    tool("export", "Export through existing renderers to a NEW file in the configured local output directory (never overwrites). PNG/SVG/PDF export one slide; PPTX/HTML export all slides and reject slideId. PDF text needs the macOS outlining service. Bridge limit: 24 MiB. Returns absolute path, bytes and SHA-256. Does not save the editable project.", obj({**SESSION, "format": {"enum": ["png", "svg", "pdf", "pptx", "html"]}, "slideId": STRING, "dpi": {"enum": [150, 300, 600]}}, [*SESSION, "format"])),
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
             "number": type(value) in (int, float), "integer": type(value) is int}
    if kind and not valid[kind]:
        raise ValueError(path + " must be " + kind + ".")
    if kind == "object":
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
        if kind == "array":
            for child in value:
                validate(child, schema["items"], path + "[]")
    elif kind in {"number", "integer"}:
        if not float("-inf") < value < float("inf") or not schema.get("minimum", float("-inf")) <= value <= schema.get("maximum", float("inf")):
            raise ValueError(path + " is outside the allowed range.")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError("The local editor must not redirect MCP requests.")


class EditorClient:
    def __init__(self, port, output_dir):
        self.origin = f"http://127.0.0.1:{port}"
        self.output_dir = Path(output_dir).expanduser().resolve()
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
            value = self.request('/api/automation/command', {"sessionId": arguments["sessionId"], "method": name.removeprefix('figure_'), "params": params}, token)
        content = []
        if name in {"figure_preview", "figure_export"}:
            value = dict(value)
            encoded = value.pop("data", "")
            raw = base64.b64decode(encoded, validate=True)
            if not raw or len(raw) > 24 * 1024 * 1024:
                raise ValueError("Invalid or oversized editor export.")
            if name == "figure_preview":
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
                      "instructions": "List sessions, select the intended page, then get_state. Mutations require its exact revision. Use batch_edit for one Undo step. Check preview after layout edits. Distinguish a browser draft from a saved project file. On timeout, inspect state and never blindly repeat edits, history or save. All geometry uses CSS px (96 px/inch)."}
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
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error('port must be between 1 and 65535')
    server = MCPServer(EditorClient(args.port, args.output_dir))
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
