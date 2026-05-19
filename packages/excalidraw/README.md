# excalidraw-cli

CLI for creating and editing [Excalidraw](https://excalidraw.com) diagrams from the command line. Designed for AI coding agents that need to produce visual diagrams as part of their workflow.

## Why

Coding agents can write code but have no way to produce visual artifacts. This CLI gives them a structured, deterministic interface for building diagrams — create shapes, connect them with arrows, style them, and render to PNG for verification. The batch command allows building complex diagrams in a single atomic operation.

## Install

Requires [Bun](https://bun.sh) runtime.

```bash
# From the monorepo root:
bun run --cwd packages/excalidraw install-global
```

This bundles the CLI and installs it to `~/.local/bin/excalidraw` with native dependencies (canvas for text measurement, resvg for PNG rendering). The install is self-contained — no link back to the repo.

For development, run directly without installing:

```bash
bun run --cwd packages/excalidraw dev -- -f diagram.excalidraw list
```

## Workflow

```bash
# 1. Create a file
excalidraw create -f diagram.excalidraw

# 2. Add shapes (returns element IDs)
excalidraw -f diagram.excalidraw draw rect -x 0 -y 0 -w 200 -h 100 --text "Service A"
# → Created rectangle abc123 at (0, 0) size 200x100 (text: lbl456)

excalidraw -f diagram.excalidraw draw rect -x 400 -y 0 -w 200 -h 100 --text "Service B"
# → Created rectangle def789 at (400, 0) size 200x100 (text: lbl012)

# 3. Connect with arrows (use IDs from step 2)
excalidraw -f diagram.excalidraw draw arrow --from abc123 --to def789 --text "HTTP"

# 4. Render to PNG and inspect
excalidraw -f diagram.excalidraw view
# → Rendered to diagram.png

# 5. Refine
excalidraw -f diagram.excalidraw edit abc123 --bg "#e3f2fd"
excalidraw -f diagram.excalidraw move abc123 --dx 50 --dy 0
```

**Always use `view` to verify.** Coordinates alone don't tell you how the diagram looks — render and inspect the PNG.

## Commands

### File management

| Command       | Description                                     |
| ------------- | ----------------------------------------------- |
| `create`      | Create a new .excalidraw file                   |
| `list` / `ls` | List all elements (IDs, types, positions, text) |
| `view`        | Render to PNG for visual inspection             |

### Drawing shapes

| Command               | Description                                   |
| --------------------- | --------------------------------------------- |
| `draw rect`           | Rectangle (with optional `--text`)            |
| `draw ellipse`        | Ellipse / circle                              |
| `draw diamond`        | Diamond shape                                 |
| `draw text <content>` | Standalone text element                       |
| `draw line`           | Line (specify `--points`)                     |
| `draw arrow`          | Arrow — use `--from`/`--to` to bind to shapes |
| `draw freedraw`       | Hand-drawn path                               |
| `draw frame`          | Frame container                               |

Common options: `-x`, `-y`, `-w`, `-h`, `--stroke`, `--bg`, `--fill`, `--text`, `--opacity`, `--roughness`

### Editing

| Command             | Description                                                    |
| ------------------- | -------------------------------------------------------------- |
| `edit <id>`         | Change colors, text, stroke, opacity, etc.                     |
| `move <ids...>`     | Move by offset (`--dx`/`--dy`) or absolute (`--to-x`/`--to-y`) |
| `resize <id>`       | Resize by dimensions (`-w`/`-h`) or scale factor (`--scale`)   |
| `delete <ids...>`   | Remove elements (cleans up bindings)                           |
| `group <ids...>`    | Group elements together                                        |
| `ungroup <groupId>` | Dissolve a group                                               |

### Batch operations

The most efficient way to build complex diagrams. Send a JSON array on stdin — the file is loaded once, all operations run in sequence, and the file is saved once.

**Back-references:** Use `$0`, `$1`, etc. to reference the ID returned by the Nth command. Use `$N.text` for the bound text element ID.

```bash
echo '[
  {"command":"draw","type":"rect","x":0,"y":0,"width":200,"height":100,"text":"A"},
  {"command":"draw","type":"rect","x":400,"y":0,"width":200,"height":100,"text":"B"},
  {"command":"draw","type":"arrow","from":"$0","to":"$1","text":"calls"},
  {"command":"edit","id":"$0","bg":"#e3f2fd"}
]' | excalidraw -f diagram.excalidraw batch
```

Supports: `draw`, `edit`, `move`, `resize`, `group`, `ungroup`, `delete`.

### Import

Bootstrap diagrams from other formats. Creates elements from stdin content.

| Command          | Description                                                         |
| ---------------- | ------------------------------------------------------------------- |
| `import mermaid` | Import mermaid flowchart with auto layout and arrow bindings        |
| `import table`   | Import CSV or markdown table as a rectangle grid with styled header |

```bash
# Mermaid flowchart — node IDs become element IDs for subsequent edit/move
echo 'flowchart TD
  A[API Server] --> B[Database]
  A --> C[Cache]' | excalidraw -f d.excalidraw import mermaid

# CSV table — cell IDs follow r{row}c{col} pattern
printf 'Service,Port\nAPI,8080\nDB,5432' | excalidraw -f d.excalidraw import table
```

Options for `import mermaid`: `-x`/`-y` (offset), `-j` (JSON output).
Options for `import table`: `-x`/`-y` (offset), `--cell-width`, `--cell-height`, `--header-bg`.

## Build

The CLI is a Bun script, not a compiled binary. Native addons (canvas, @resvg/resvg-js) are required at runtime for text measurement and PNG rendering.

```bash
bun run --cwd packages/excalidraw build           # Bundle to dist/cli.js
bun run --cwd packages/excalidraw install-global   # Build + install to ~/.local/bin/
```

The `build` step patches css-tree's `createRequire()` calls (which break in bundled output) to use static imports, bundles everything except native addons into a single JS file, then restores the originals.

The `install-global` step runs `build`, copies the bundle to `~/.local/lib/excalidraw/`, installs native addons there, and creates a shim at `~/.local/bin/excalidraw`.

## Architecture

```
src/
├── cli.ts                    # Command definitions (commander)
├── version.ts                # Version from package.json
├── dom-shim.ts               # DOM globals provider (linkedom + @napi-rs/canvas)
├── svg-measure.ts            # SVG getBBox/getComputedTextLength for linkedom
├── commands/
│   ├── create.ts             # Create .excalidraw files
│   ├── draw.ts               # Shape creation (rect, ellipse, arrow, etc.)
│   ├── edit.ts               # Modify element properties
│   ├── view.ts               # Render to PNG
│   ├── move.ts               # Move elements
│   ├── resize.ts             # Resize elements
│   ├── delete.ts             # Delete elements
│   ├── query.ts              # List, filter, and traverse elements
│   ├── group.ts              # Group/ungroup
│   ├── batch.ts              # Multi-command execution with back-references
│   ├── import-mermaid.ts     # Import mermaid flowcharts from stdin
│   └── import-table.ts       # Import CSV/markdown tables from stdin
├── import/
│   └── table-parser.ts       # CSV and markdown table parser
├── elements/
│   ├── element-factory.ts    # Build skeletons, convert via skeleton-converter
│   ├── skeleton-converter.ts # Dispatch skeletons to @excalidraw/element factory functions
│   ├── element-defaults.ts   # Default values (colors, sizes, fonts)
│   ├── element-id.ts         # ID generation
│   ├── element-query.ts      # Find elements by ID/type
│   └── excalidraw-types.ts   # Type definitions
├── file/
│   └── excalidraw-file.ts    # Load/save .excalidraw JSON
├── binding/
│   └── arrow-binding.ts      # Cleanup bindings on delete
└── render/
    └── render-png.ts         # SVG → PNG via @resvg/resvg-js
```

Key dependencies:

- **@excalidraw/element** — element creation via factory functions (`newElement`, `newArrowElement`, etc.)
- **@excalidraw/utils** — SVG export via `exportToSvg`
- **jsdom** — DOM environment required by @excalidraw APIs
- **canvas** — text measurement for labeled shapes (native addon)
- **@resvg/resvg-js** — SVG to PNG rendering (native addon)
- **cli-common** — shared CLI utilities (output formatting, update system)
