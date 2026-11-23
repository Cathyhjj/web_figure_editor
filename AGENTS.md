# Working with Figure Editor

This repository is both an editable figure app and a local agent-controlled drawing workspace.
For drawing tasks, use the live editor tools; implementation changes are only needed when the user requests app development.

## Draw and refine

- Use the open editor when available. To start one, run `python3 server.py` and open `http://127.0.0.1:8766/`. The page must show **AI connected**. For first-time MCP setup, `python3 figure_cli.py setup` prints registration commands for Codex and Claude Code.
- List sessions before opening the URL. Reuse a connected page; every extra tab loads the whole project into memory again and shares the same browser draft.
- Prefer the `figure_*` MCP tools. Without MCP, use `python3 figure_cli.py tools` to discover the same schemas, then `sessions` and `call TOOL --args FILE.json` (or `--args -` for stdin).
- Read sessions, identify the intended page, then `get_state`. Do not guess if several pages match. Read actual slide/object/asset IDs and the current revision.
- When the user supplies a reference from **Layers → Copy AI reference**, call `get_state` with the copied `sessionId` and `slideId`. Verify the live project's ID matches `projectId` and that every `selectedItemIds` entry exists on that slide. Use those IDs and the live revision for edits. If the session expired, project changed or an item is missing, ask for a fresh reference from the intended page.
- Use `preview_batch`, inspect the returned image, then `batch_edit` with the same operations and revision. Each batch is one Undo step. A preview is a proposal, not an applied change.
- For a new composition, use `add_slide` with a new unique `slideId`, optional `name` and `canvas`. Subsequent operations in the batch can target that ID. `set_slide` changes name or canvas without scaling existing objects.
- Keep text and annotations editable: `add_text`, `add_shape`, and `place_asset` create native frontend objects. Name objects by their role (e.g. “Panel b: EXAFS fit”). Use `get_state` and returned IDs for subsequent edits, rather than relying on names being unique.
- Geometry is CSS px: 96 px = 1 inch; mm × 96 / 25.4 = px. Native primitives are `rect`, `roundRect`, `ellipse`, `line`, `arrow`, `doubleArrow`. Horizontal/vertical lines may have one zero dimension. `fill`/`stroke` updates replace the corresponding gradient with a solid paint.
- Generate scientific plots using the user's source data and plotting code, then import SVG/PNG/JPEG from an explicitly configured `--asset-root`. Prefer SVG with text retained when labels need editing; raster images do not expose editable plotted data or internal labels.
- If the registered MCP has no asset root, the CLI can import from the drawing's output directory for that call. Use `figure_cli.py --asset-root /absolute/plot-output call import_assets --args imports.json`, then use the returned asset IDs and revision in the same live page.
- When a source plot changes: `check_sources` → `import_assets` → `preview_batch` → `replace_asset` for selected placements. `replace_asset` preserves crop/frame/style; `swap_asset` resets crop and fits the whole replacement. Do not replace untouched panels or alter source data to improve appearance.
- The user can continue in the frontend immediately: select a layer, drag/resize, edit text, or use Fill & Line / Edit SVG elements. Read state again after manual edits. Locked objects and active gestures must be respected.
- Save the editable `.figure.json`, not just a PNG. File save needs an already authorized file; the first file is chosen through the page's Save button. Browser drafts and exported images are different from saved project files. Run `check_export` before final export.
- On stale revision, rebuild from fresh state. On timeout, inspect state before retrying; do not repeat a potentially delivered mutation automatically.

See [the agent guide](docs/agent-workflow.md) and [the editable composition example](examples/agent-composition.json).

## Develop the app

- Inspect `git status` first and preserve unrelated local changes. Keep changes scoped; do not commit or push unless requested.
- The browser document is authoritative. Reuse `prepareBatch`, `validateDeck`, `change()` and existing renderers; do not add a separate agent-only scene model.
- Keep `figure_mcp.py` schemas, `automation.js` validation/state, and `app.js` dispatch in sync. The CLI uses the same MCP definitions and client.
- Validate with `npm test`, `python3 -m unittest discover -s tests -p 'test_automation.py'`, `python3 -m unittest discover -s tests -p 'test_figure_cli.py'`, and `npm run test:automation`. Browser tests use synthetic files, isolated Chrome and a temporary server; `PLAYWRIGHT_MODULE` can point at an installed Playwright module.
