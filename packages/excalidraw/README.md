# excalidraw-cli

CLI for creating and editing [Excalidraw](https://excalidraw.com) diagrams from the command line. Designed for AI coding agents that need to produce visual diagrams as part of their workflow.

## Why

Coding agents can write code but have no way to produce visual artifacts. This CLI gives them a structured, deterministic interface for building diagrams — create shapes, connect them with arrows, style them, and render to PNG for verification. The batch command allows building complex diagrams in a single atomic operation.

## Install

```bash
# From the monorepo root:
pnpm -C packages/excalidraw run install-global
```

This compiles a standalone binary (`dist/excalidraw`, via `bun build --compile`), copies it to `~/.local/bin/excalidraw`, and ad-hoc signs it on macOS. The binary embeds the `@napi-rs/canvas` native module and fonts, which are extracted to `~/.cache/excalidraw-cli/` on first run.

For development, run directly from source without installing:

```bash
bun packages/excalidraw/src/cli.ts -f diagram.excalidraw query
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

Pass `--id <name>` to `draw` to use a readable, stable ID instead of a generated one. Every command accepts `-j, --json` for structured output.

## Commands

### File management

| Command                              | Description                                                               |
| ------------------------------------ | ------------------------------------------------------------------------- |
| `create`                             | Create a new .excalidraw file (`--bg`, `--force`)                         |
| `query [ids...]` (`q`, `list`, `ls`) | List elements, look up IDs, filter, or traverse arrow connections         |
| `view`                               | Render to PNG for visual inspection (`-o`, `--scale`, `--padding`)        |
| `lint`                               | Check binding integrity, arrow connections, duplicate IDs, bounding boxes |

`query` options: `--type <type>`, `--text <glob>`, `--connected` with `--depth <n>` and `--direction in|out|both`, and `--ids` for newline-separated IDs suitable for piping. `view` writes `<input-basename>.png` next to the file by default and renders in Excalidraw's dark theme.

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
| `draw frame`          | Frame container (`--name`, `--children`)      |

Common options: `--id`, `-x`, `-y`, `--stroke`, `--bg`, `--fill`, `--stroke-width`, `--stroke-style`, `--roughness`, `--opacity`. Shapes (`rect`, `ellipse`, `diamond`) add `-w`, `-h`, `--round`, `--text`, `--text-font-size`. Arrows add `--points`, `--start-head`/`--end-head` (`none|arrow|bar|dot|triangle`), and `--text`. Run `excalidraw draw <shape> --help` for the full list.

### Editing

| Command                  | Description                                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| `edit <id>`              | Change colors, text, stroke, opacity, font, lock state                                               |
| `move [ids...]`          | Move by offset (`--dx`/`--dy`) or absolute (`--to-x`/`--to-y`)                                       |
| `resize <id>`            | Resize by dimensions (`-w`/`-h`) or scale factor (`--scale`)                                         |
| `delete [ids...]` (`rm`) | Remove elements and, by default, their bound text and connected arrows (`--no-cascade` to keep them) |
| `group <ids...>`         | Group elements together                                                                              |
| `ungroup <groupId>`      | Dissolve a group                                                                                     |

### Piping

`query`, `view`, `move`, and `delete` read element IDs from stdin when none are given as arguments. Input can be newline- or comma-separated IDs, a JSON array, or element objects (e.g. `jq` output — the `.id` field is extracted). Piping IDs to `view` renders only those elements (plus their bound text).

```bash
excalidraw -f d.excalidraw query api --connected --ids | excalidraw -f d.excalidraw delete
excalidraw -f d.excalidraw query --type arrow --ids | excalidraw -f d.excalidraw view -o arrows.png
```

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

Supports: `draw`, `edit`, `move`, `resize`, `group`, `ungroup`, `delete`. Fields mirror the CLI options in camelCase (`width`, `strokeStyle`, `startHead`, `fontSize`, …); `edit`/`resize` take `id`, `move`/`delete`/`group` take `ids` (or a single `id`), and `ungroup` takes `groupId`. Failed operations are reported per entry; the file is saved if any operation succeeded.

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

Options for `import mermaid`: `-x`/`-y` (offset). Only flowchart/graph diagrams produce editable elements; other mermaid types are rejected.

Options for `import table`: `-x`/`-y` (offset), `--cell-width`, `--cell-height`, `--header-bg`. Markdown is detected by `|` characters; otherwise input is parsed as CSV.

## Development

```bash
pnpm -C packages/excalidraw run build            # Compile to dist/excalidraw
pnpm -C packages/excalidraw run install-global   # Build + install to ~/.local/bin/
pnpm -C packages/excalidraw run typecheck
```

Elements are created through `@excalidraw/element` factory functions inside a `linkedom` DOM shim, with `@napi-rs/canvas` providing text measurement and PNG rendering. Shared CLI output handling comes from `@bizimind/cli-common`.
