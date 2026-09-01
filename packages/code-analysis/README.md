# code-analysis

Live code visualization CLI. Pick an analysis type, point it at a directory, and get an interactive visualization in your browser that hot-reloads as files change.

```
code-analysis -p loc -w packages/my-package
```

## Installation

```bash
bun install
```

Or use it directly from the repo without installing:

```bash
bun run packages/code-analysis/src/cli.ts -p loc
```

## Usage

```
code-analysis [options] [command]

Commands:
  list    List all available plugins
  run     Run a plugin and open the visualization (default command)
  help    Display help for a command
```

### Running an analysis

`run` is the default command — you don't need to type it:

```bash
code-analysis -p <plugin> [-w <path>] [--port <n>] [--no-open]
```

| Flag            | Default      | Description                                                       |
| --------------- | ------------ | ----------------------------------------------------------------- |
| `-p, --plugin`  | _(required)_ | Plugin to run. See [plugin specifiers](#plugin-specifiers) below. |
| `-w, --workdir` | cwd          | Directory to analyze.                                             |
| `--port`        | `0` (random) | Port for the local dev server.                                    |
| `--no-open`     | —            | Skip opening the browser automatically.                           |

### Listing plugins

```bash
code-analysis list          # human-readable table
code-analysis list --json   # machine-readable JSON
```

## Plugin specifiers

The `-p` flag accepts three forms:

```bash
# Built-in plugin by id
code-analysis -p loc

# Variant: append /<variant> to filter the view
code-analysis -p lint-issues/no-console

# Local file (relative or absolute path)
code-analysis -p ./my-plugin.ts
code-analysis -p /absolute/path/to/plugin.ts

# npm package
code-analysis -p code-analysis-plugin-custom
```

A plugin loaded from a path or package is validated against the plugin schema on load. If the shape is wrong, you'll get a clear error before anything starts.

## Built-in plugins

### `loc` — Lines of code

Treemap of source file sizes by line count. Covers `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`. Excludes `node_modules`, `.git`, and `dist`.

```bash
code-analysis -p loc
code-analysis -p loc -w packages/my-package
```

---

### `languages` — File size by language

Treemap grouped by file extension, sized by bytes. The top-level nodes are extensions (`ts`, `json`, `md`, …); children are the files.

```bash
code-analysis -p languages
```

---

### `disk-utilization` — Disk usage per file

Treemap of every file sized by bytes on disk. Useful for finding large generated or vendored files. Excludes `node_modules` and `.git`.

```bash
code-analysis -p disk-utilization
```

---

### `git-churn` — Git commit churn

Treemap sized by total lines changed across all commits (`additions + deletions`). Files touched most often by commits appear largest.

```bash
code-analysis -p git-churn
```

**Requires:** a git repository at `--workdir`.

---

### `lint-issues` — Lint violations

Treemap of lint violations per file. Each violation is one record; the map sizes files by violation count.

```bash
# All violations
code-analysis -p lint-issues

# Filter to a single rule
code-analysis -p lint-issues/no-console
code-analysis -p lint-issues/no-unused-vars
```

Tries **oxlint** first (`bunx oxlint -f json`), falls back to **ESLint** (`bunx eslint -f json`). Whichever produces valid JSON output is used.

**Variant:** rule name as it appears in the linter output (e.g. `no-console`, `typescript/no-explicit-any`).

---

### `type-issues` — TypeScript type errors

Treemap of TypeScript errors per file, sized by error count.

```bash
# All type errors
code-analysis -p type-issues

# Filter to a specific error code
code-analysis -p type-issues/TS2345
code-analysis -p type-issues/TS7006
```

Runs **tsc** with `--noEmit`, falling back to the preview-era **tsgo** command for projects
that have not migrated yet.

**Variant:** TypeScript error code (e.g. `TS2345`, `TS7006`).

---

### `import-graph` — Import dependency graph

Force-directed network graph of `import` edges between source files. Nodes are files; edges are imports. Covers `.ts`, `.tsx`, `.js`, `.jsx`. Only relative imports are tracked (package imports are not file nodes).

```bash
# Full graph
code-analysis -p import-graph

# Scoped to a subtree
code-analysis -p import-graph/src/components
```

**Variant:** a path prefix — only files under that prefix appear as sources or targets.

**Interaction:**

- Drag nodes to pin them in place
- Scroll to zoom, drag background to pan
- Hover a node to see its in/out degree and full path

---

## How live updates work

The visualization is served by a local Vite dev server. When a source file matching the plugin's watch patterns changes on disk, the plugin re-runs and the browser reloads automatically — no manual refresh needed.

```
edit src/foo.ts → watcher fires → plugin re-runs → data.json rewritten → browser reloads
```

Vite starts once and stays running until you press `Ctrl-C`. On exit, the dev server and temporary data files are cleaned up automatically.

---

## Building a plugin

A plugin is any module with a default export that satisfies the `AnalysisPlugin` interface. You can write one in TypeScript and pass it directly with `-p ./my-plugin.ts`.

### Interface

```typescript
import type { AnalysisPlugin, AnalysisRecord, VizConfig } from "code-analysis/plugin";

const plugin: AnalysisPlugin = {
  meta: {
    id: "my-plugin", // unique id, shown in `list`
    description: "What it does",
    vizType: "treemap", // "treemap" | "network-graph"
    options: [
      { key: "myOption", description: "What it controls", default: "default-value" },
      { key: "required", description: "This must be provided", required: true },
    ],
    watchGlobs: ["src/**/*.ts"], // globs that trigger a re-run on change
  },

  async generate(workDir, args) {
    // Run your analysis. Return a flat array of records.
    // Every record must have a `path` field.
    // Additional fields depend on the visualization type.
    return [{ path: "src/foo.ts", myMetric: 42 }];
  },

  buildConfig(workDir, args) {
    // Return the config for the chosen visualization.
    return {
      vizType: "treemap",
      title: "My Plugin",
      unit: "units",
      valueField: "myMetric", // which numeric field to size cells by
      filter: {}, // optional categorical filters
    };
  },
};

export default plugin;
```

### Treemap records

For a treemap plugin, each record needs a `path` (slash-separated, becomes the hierarchy) and at least one numeric field used as `valueField`:

```typescript
{ path: "packages/foo/src/bar.ts", lines: 142, language: "ts" }
```

One path can appear in multiple records — values are summed. Categorical fields can be used as `filter` keys to let the same dataset power multiple views.

### Network graph records

For a network-graph plugin, each record needs the source and target fields declared in the config:

```typescript
{ path: "src/a.ts", source: "src/a.ts", target: "src/b.ts" }
```

(`path` is still required by the record schema; by convention, set it to `source`.)

### Variant handling

If `supportsVariants: true`, the part after `/` in the plugin specifier is passed as the second argument to both `generate` and `buildConfig`. You decide what it means.

```bash
code-analysis -p my-plugin/some-variant
#                           ^^^^^^^^^^^^
#                           variant === "some-variant"
```

Common patterns:

- A filter key/value written into `config.filter` (used by the treemap HTML natively)
- A path prefix to scope the analysis to a subtree
- A specific rule, code, or category name

### Using an npm package

Export your plugin as the package's default export and publish it. Users install and run it by package name:

```bash
bun add -g code-analysis-plugin-my-tool
code-analysis -p code-analysis-plugin-my-tool
```

The plugin is validated on load — if the shape is wrong, a descriptive error is shown before the server starts.

---

## Visualization reference

### Treemap

Zoomable nested treemap (d3). Click a directory node to zoom in; click the breadcrumb header to zoom back out. Hover a cell to see its full path, value, and percentage of the current view.

The treemap is driven by two JSON files written at startup and refreshed on each re-run:

- `data.json` — flat array of records produced by the plugin
- `config.json` — title, unit, `valueField`, and optional `filter`

URL params `?title=`, `?unit=`, `?valueField=` override `config.json` (useful for sharing a specific view).

### Network graph

Force-directed graph (d3-force). Nodes are files; edges are directed relationships. Zoom with the scroll wheel, pan by dragging the background, drag nodes to pin them.

Same hot-reload contract as the treemap — rewrites `data.json` → Vite pushes a full reload.
