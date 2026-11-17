#!/usr/bin/env python3
"""One-shot JSON interface to the live editor, sharing the MCP tools and validation."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import secrets
import sys

from figure_mcp import EditorClient, TOOLS


def tool_name(name):
    return name if name.startswith('figure_') else 'figure_' + name


def read_arguments(source):
    if source == '-':
        raw = sys.stdin.buffer.read(1024 * 1024 + 1)
    else:
        with Path(source).open('rb') as stream:
            raw = stream.read(1024 * 1024 + 1)
    if len(raw) > 1024 * 1024:
        raise ValueError('Arguments exceed the 1 MiB command limit.')
    def reject_constant(value):
        raise ValueError('Invalid JSON number: ' + value)
    value = json.loads(raw, parse_constant=reject_constant)
    if not isinstance(value, dict):
        raise ValueError('Arguments must be a JSON object.')
    return value


def compact_result(reply, output_dir):
    """Keep binary previews out of agent context; never overwrite an existing file."""
    if reply.get('isError'):
        raise ValueError(next((block['text'] for block in reply.get('content', []) if block['type'] == 'text'), 'Editor command failed.'))
    result = {'ok': True, 'result': reply['structuredContent']}
    images = []
    for block in reply.get('content', []):
        if block['type'] != 'image':
            continue
        data = base64.b64decode(block['data'], validate=True)
        if block.get('mimeType') != 'image/png' or not data.startswith(b'\x89PNG\r\n\x1a\n') or len(data) > 24 * 1024 * 1024:
            raise ValueError('Invalid preview image.')
        directory = Path(output_dir).expanduser().resolve()
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / ('preview-' + secrets.token_hex(12) + '.png')
        with path.open('xb') as stream:
            stream.write(data)
        images.append({'path': str(path), 'mimeType': 'image/png', 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
    if images:
        result['images'] = images
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8766)
    parser.add_argument('--asset-root', type=Path)
    parser.add_argument('--output-dir', type=Path, default=Path(__file__).resolve().parent / 'output' / 'mcp')
    commands = parser.add_subparsers(dest='command', required=True)
    catalog = commands.add_parser('tools', help='Show tool schemas without connecting to the editor.')
    catalog.add_argument('tool', nargs='?', help='Optional tool name, with or without figure_ prefix.')
    commands.add_parser('sessions', help='List connected pages; never selects one automatically.')
    call = commands.add_parser('call', help='Run a tool once. On timeout read state before retrying.')
    call.add_argument('tool')
    call.add_argument('--args', required=True, help='JSON arguments file, or - for stdin.')
    args = parser.parse_args(argv)
    try:
        if not 1 <= args.port <= 65535:
            raise ValueError('port must be between 1 and 65535')
        if args.command == 'tools':
            definitions = [tool for tool in TOOLS if not args.tool or tool['name'] == tool_name(args.tool)]
            if not definitions:
                raise ValueError('Unknown Figure Editor tool.')
            result = {'ok': True, 'tools': definitions}
        else:
            name = 'figure_sessions' if args.command == 'sessions' else tool_name(args.tool)
            arguments = {} if args.command == 'sessions' else read_arguments(args.args)
            client = EditorClient(args.port, args.output_dir, args.asset_root)
            result = compact_result(client.call(name, arguments), args.output_dir)
        print(json.dumps(result, ensure_ascii=False, allow_nan=False))
        return 0
    except (ValueError, OSError, RecursionError) as error:
        print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
