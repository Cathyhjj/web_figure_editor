#!/usr/bin/env python3
"""One-shot JSON interface to the live editor, sharing the MCP tools and validation."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import secrets
import shlex
import sys

from figure_mcp import AssetRoot, EditorClient, TOOLS


REPO_DIR = Path(__file__).resolve().parent
DEFAULT_OUTPUT_DIR = REPO_DIR / 'output' / 'mcp'


def tool_name(name):
    return name if name.startswith('figure_') else 'figure_' + name


def setup_commands(args):
    """Generate commands for this checkout and interpreter without changing client settings."""
    port = ['--port', str(args.port)] if args.port != 8766 else []
    server = [sys.executable, str(REPO_DIR / 'server.py'), *port]
    adapter = [sys.executable, str(REPO_DIR / 'figure_mcp.py'), *port]
    if args.asset_root is not None:
        adapter.extend(['--asset-root', str(AssetRoot(args.asset_root).path)])
    if args.output_dir != DEFAULT_OUTPUT_DIR:
        adapter.extend(['--output-dir', str(args.output_dir.expanduser().resolve())])
    return {
        'ok': True,
        'startServer': shlex.join(server),
        'editorUrl': f'http://127.0.0.1:{args.port}/',
        'register': {
            'codex': shlex.join(['codex', 'mcp', 'add', 'figure_editor', '--', *adapter]),
            'claude': shlex.join(['claude', 'mcp', 'add', '--transport', 'stdio', 'figure_editor', '--', *adapter]),
        },
    }


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


def list_sessions(client):
    try:
        result = compact_result(client.call('figure_sessions', {}), client.output_dir)
    except (ValueError, OSError) as error:
        raise ValueError(f'{error} Check {client.origin}/. Run figure_cli.py setup with the same port for the launch command.') from error
    if result['result']['sessions']:
        result['nextStep'] = 'Identify the intended page by its project and slide, then call get_state with its sessionId.'
    else:
        result['nextStep'] = f'Open {client.origin}/ or resume AI control in the editor until it shows AI connected. Then list sessions again.'
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8766)
    parser.add_argument('--asset-root', type=Path)
    parser.add_argument('--output-dir', type=Path, default=DEFAULT_OUTPUT_DIR)
    commands = parser.add_subparsers(dest='command', required=True)
    catalog = commands.add_parser('tools', help='Show tool schemas without connecting to the editor.')
    catalog.add_argument('tool', nargs='?', help='Optional tool name, with or without figure_ prefix.')
    commands.add_parser('setup', help='Print local server and MCP registration commands for Codex and Claude Code.')
    commands.add_parser('sessions', help='List connected pages; never selects one automatically.')
    call = commands.add_parser('call', help='Run a tool once. On timeout read state before retrying.')
    call.add_argument('tool')
    call.add_argument('--args', required=True, help='JSON arguments file, or - for stdin.')
    args = parser.parse_args(argv)
    try:
        if not 1 <= args.port <= 65535:
            raise ValueError('port must be between 1 and 65535')
        if args.command == 'setup':
            result = setup_commands(args)
        elif args.command == 'tools':
            definitions = [tool for tool in TOOLS if not args.tool or tool['name'] == tool_name(args.tool)]
            if not definitions:
                raise ValueError('Unknown Figure Editor tool.')
            result = {'ok': True, 'tools': definitions}
        else:
            client = EditorClient(args.port, args.output_dir, args.asset_root)
            if args.command == 'sessions':
                result = list_sessions(client)
            else:
                result = compact_result(client.call(tool_name(args.tool), read_arguments(args.args)), args.output_dir)
        print(json.dumps(result, ensure_ascii=False, allow_nan=False, indent=2 if args.command == 'setup' else None))
        return 0
    except (ValueError, OSError, RecursionError) as error:
        print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
