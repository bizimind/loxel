# code-analysis

Code analysis CLI. Pick an analysis plugin, point it at a directory, and get the results as a table, as JSON, or as an interactive browser visualization that live-reloads as files change.

```
code-analysis -p loc -w packages/my-package --web
```

## Installation

Download the released binary for your platform (listed in [the manifest](https://loxel.bizimind.io/code-analysis/manifest.json)):

```bash
curl -fsSL https://loxel.bizimind.io/code-analysis/darwin-arm64/code-analysis -o ~/.local/bin/code-analysis && chmod +x ~/.local/bin/code-analysis
```

Or build from the loxel monorepo (`bun build --compile` into `dist/code-analysis`):

```bash
pnpm -C packages/code-analysis run build
```

Or run directly from source without building:

```bash
bun packages/code-analysis/src/cli.ts -p loc
```

## Usage

```
code-analysis [options] [command]

Commands:
  run            Run a plugin and print results, or serve a visualization with --web (default command)
  list           List all available plugins
  help <plugin>  Show a plugin's description and options
```

### Running an analysis

`run` is the default command — you don't need to type it:

```bash
code-analysis -p <plugin> [-w <path>] [-a key=value ...] [--web [--port <n>]] [-j]
```

| Flag            | Default      | Description                                                                  |
| --------------- | ------------ | ---------------------------------------------------------------------------- |
| `-p, --plugin`  | _(required)_ | Plugin to run. See [plugin specifiers](#plugin-specifiers) below.            |
| `-w, --workdir` | cwd          | Directory to analyze.                                                        |
| `-a, --arg`     | —            | Plugin option as `key=value`. Repeatable. See `code-analysis help <plugin>`. |
| `--web`         | off          | Serve an interactive visualization instead of printing results.              |
| `--port`        | `0` (random) | Port for the web server (only with `--web`).                                 |
| `-j, --json`    | off          | Print results as JSON.                                                       |

Without `--web`, results are printed as a table of paths sorted by the plugin's value field. With `--web`, the server URL is printed (open it in a browser) and the process keeps running until `Ctrl-C`.

### Listing plugins

```bash
code-analysis list          # human-readable table
code-analysis list --json   # machine-readable JSON
```

## Plugin specifiers

The `-p` flag accepts:

```bash
# Built-in plugin by id
code-analysis -p loc

# Local file (relative or absolute path)
code-analysis -p ./my-plugin.ts
code-analysis -p /absolute/path/to/plugin.ts

# Scoped npm package
code-analysis -p @my-scope/code-analysis-plugin
```

A bare name that is not a built-in id is reported as an unknown plugin. A plugin loaded from a path or package is validated against the plugin schema on load; if the shape is wrong, you get an error before anything runs.

## Built-in plugins

### `loc` — Lines of code

Treemap of source file sizes by line count. Covers `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`. Excludes `node_modules`, `.git`, and `dist`.

```bash
code-analysis -p loc
code-analysis -p loc -w packages/my-package
```

---

### `languages` — File size by language

Treemap grouped by file extension, sized by bytes. The top-level nodes are extensions (`ts`, `json`, `md`, …); children are the files. Excludes `node_modules`, `.git`, and `dist`.

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

Treemap sized by total lines changed across all commits (`additions + deletions`, from `git log --numstat`). Binary files are skipped.

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
code-analysis -p lint-issues -a rule=no-console
```

Tries **oxlint** first (`bunx oxlint -f json`), falls back to **ESLint** (`bunx eslint -f json`).

**Options:** `rule` — rule name as it appears in the linter output (e.g. `no-console`, `typescript/no-explicit-any`).

---

### `type-issues` — TypeScript type errors

Treemap of TypeScript errors per file, sized by error count.

```bash
# All type errors
code-analysis -p type-issues

# Filter to a specific error code
code-analysis -p type-issues -a code=TS2345
```

Runs `bunx tsc --noEmit`, falling back to the preview-era `tsgo` command for projects that have not migrated yet.

**Options:** `code` — TypeScript error code (e.g. `TS2345`, `TS7006`).

---

### `import-graph` — Import dependency graph

Force-directed network graph of import edges between source files, built with dependency-cruiser. Nodes are files; edges are imports. `node_modules` are not followed; `.git` and `dist` are excluded.

```bash
# Full graph
code-analysis -p import-graph --web

# Scoped to a subtree
code-analysis -p import-graph -a scope=src/components --web
```

**Options:** `scope` — root path to scope the graph; `threshold` (default `3`) — modules imported more than N times are treated as shared modules: colored in the legend and shown as small dots on the nodes that import them. The threshold can also be adjusted in the page or via `?threshold=`.

**Interaction:**

- Drag nodes to reposition them
- Scroll to zoom, drag background to pan
- Hover a node to see its full path, in/out degree, and the shared modules it uses

---

## How live updates work

With `--web`, the visualization is served by a local Bun server. When a file matching the plugin's `watchGlobs` changes on disk, the plugin re-runs and connected browsers reload automatically — no manual refresh needed.

```
edit src/foo.ts → watcher fires → plugin re-runs → data.json rewritten → browser reloads
```

The server runs until you press `Ctrl-C`; temporary data files are cleaned up on exit.

---

## Building a plugin

A plugin is any module whose default export satisfies the `AnalysisPlugin` interface (defined in `src/plugin.ts`). You can write one in TypeScript and pass it directly with `-p ./my-plugin.ts`.

### Interface

```typescript
const plugin = {
  meta: {
    id: "my-plugin", // unique id, shown in `list`
    description: "What it does",
    vizType: "treemap", // "treemap" | "network-graph"
    options: [
      // passed via -a key=value; shown by `code-analysis help my-plugin`
      { key: "myOption", description: "What it controls", default: "default-value" },
      { key: "required", description: "This must be provided", required: true },
    ],
    watchGlobs: ["src/**/*.ts"], // globs that trigger a re-run on change (with --web)
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

`args` holds the `-a` values with option defaults applied; a missing `required` option exits with an error before `generate` runs.

### Treemap records

For a treemap plugin, each record needs a `path` (slash-separated, becomes the hierarchy) and at least one numeric field used as `valueField`:

```typescript
{ path: "packages/foo/src/bar.ts", lines: 142, language: "ts" }
```

One path can appear in multiple records — values are summed. Categorical fields can be used as `filter` keys to let the same dataset power multiple views.

### Network graph records

For a network-graph plugin, `buildConfig` returns `{ vizType: "network-graph", title, sourceField, targetField, weightField?, threshold? }`, and each record needs the declared source and target fields:

```typescript
{ path: "src/a.ts", source: "src/a.ts", target: "src/b.ts" }
```

(`path` is still required by the record schema; by convention, set it to `source`.)

### Using an npm package

Export your plugin as the package's default export, publish it under a scope, install it where it can be resolved, and run it by package name:

```bash
code-analysis -p @my-scope/code-analysis-plugin
```

---

## Visualization reference

### Treemap

Zoomable nested treemap (d3). Click a directory node to zoom in; click the breadcrumb header to zoom back out. Hover a cell to see its full path, value, and percentage of the current view.

The treemap is driven by two JSON files written at startup and refreshed on each re-run:

- `data.json` — flat array of records produced by the plugin
- `config.json` — title, unit, `valueField`, and optional `filter`

URL params `?title=`, `?unit=`, `?valueField=` override `config.json` (useful for sharing a specific view).

### Network graph

Force-directed graph (d3-force). Nodes are files; edges are directed relationships. Zoom with the scroll wheel, pan by dragging the background, drag nodes to reposition them.

Same live-reload contract as the treemap.
