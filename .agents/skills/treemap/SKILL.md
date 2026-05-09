---
name: treemap
description: Build a zoomable nested d3 treemap from hierarchical data (slash-separated paths + numeric values or counted records). Use when the user asks to visualize a distribution, breakdown, or proportion grouped by a path-like hierarchy — e.g., lines of code, disk usage, bundle sizes, dependencies, languages, git churn, lint issues, test durations, messages per channel.
---

# Treemap

Zoomable nested d3 treemap served from the skill's `resources/` dir. You write two JSON files next to `index.html` and vite serves + hot-reloads. Vite starts once and stays up; iteration is just editing files.

## Two files drive everything

- **`resources/data.json`** — flat array of atomic records. Every record has `path`; everything else is optional metadata. Heavy to produce (linting, `du -a`, parsing bundle stats), so you generate it once and reuse it.
- **`resources/config.json`** — UI labels + which records to include + which numeric column to sum. Cheap to edit. Changing it re-slices the data in the browser without touching `data.json`.

Both files live inside vite's root; the vite plugin pushes a full browser reload whenever either is rewritten.

## Data shape

```json
[
  { "path": "packages/a/b.ts", "lines": 142 },
  { "path": "packages/a/b.ts", "rule": "no-undef", "severity": "error" },
  { "path": "src/foo.py", "language": "python", "bytes": 2048 }
]
```

- **`path`** — slash-separated; every prefix becomes a directory node.
- **Numeric fields** (e.g. `lines`, `bytes`, `size`) — pick one as the value axis via `config.valueField`.
- **Categorical fields** (e.g. `language`, `rule`, `severity`) — used for filtering via `config.filter`.
- If the chosen value field is absent from records, each record counts as `1` (event-shaped data: lint diagnostics, commits, etc.).

One path can appear in many records — they sum on aggregation.

## Config shape

```json
{
  "title": "Lint: no-console",
  "unit": "issues",
  "valueField": "bytes",
  "filter": { "rule": "eslint(no-console)", "severity": ["error", "warning"] }
}
```

- **`title`** / **`unit`** — header text and suffix after numbers.
- **`valueField`** — numeric field to sum per path. Default `"value"`; legacy `{path, lines}` auto-detected.
- **`filter`** — map of `field → value` or `field → [v1, v2, ...]`. A record is kept only if every filter key matches.

URL params `?title=`, `?unit=`, `?valueField=` override `config.json` (useful to share different views from the same data).

## Workflow

```bash
RESOURCES=.agents/skills/treemap/resources

# 1. Generate data once.
<your-generator> > "$RESOURCES/data.json"

# 2. Write a config (optional — defaults are fine for simple cases).
cat > "$RESOURCES/config.json" <<'EOF'
{ "title": "My viz", "unit": "lines", "valueField": "lines" }
EOF

# 3. Start vite once — leave running.
bun x vite "$RESOURCES" --port 5173 &
until curl -fsS http://localhost:5173 >/dev/null 2>&1; do sleep 1; done
loxel http://localhost:5173
```

From here on:

- **Re-slice the same data**: edit `config.json` — change `filter`, `valueField`, labels. Page hot-reloads.
- **Refresh the data**: rewrite `data.json` (re-run your generator). Page hot-reloads.
- **New dataset entirely**: overwrite both. Same vite instance.

You almost never need to restart vite. Never kill it unless you're done.

### Alternative: stdin (one-shot)

If you don't want any file on disk, pipe the JSON into vite's stdin. It's read once at config load and injected inline — no hot-reload path for stdin-driven data.

```bash
<your-generator> | bun x vite "$RESOURCES" --port 5173
```

## Examples

### Lines of code per tracked file

```bash
RESOURCES=.agents/skills/treemap/resources
git ls-files -z -- 'packages/*' \
  | xargs -0 wc -l 2>/dev/null \
  | awk 'NF==2 && $2 != "total" { printf "%d\t%s\n", $1, $2 }' \
  | jq -Rn '[inputs | split("\t") | {lines: (.[0]|tonumber), path: .[1]}]' \
  > "$RESOURCES/data.json"

cat > "$RESOURCES/config.json" <<'EOF'
{ "title": "LOC", "unit": "lines", "valueField": "lines" }
EOF
```

Gitignored content is excluded naturally — `git ls-files` only lists tracked files.

### Lint issues — live-configurable rule filter

Generate once with every diagnostic as its own record. Then switch rules by editing only `config.json`:

```bash
# With oxlint (native JSON output):
bun x oxlint -f json . 2>/dev/null \
  | jq '[.diagnostics[] | {path: .filename, rule: .code, severity}]' \
  > "$RESOURCES/data.json"

# With ESLint:
bunx eslint -f json . \
  | jq '[.[] | .filePath as $p | .messages[] | {path: $p, rule: .ruleId, severity}]' \
  > "$RESOURCES/data.json"
```

Now edit `config.json` to pick a rule:

```json
{ "title": "no-console", "unit": "issues", "filter": { "rule": "eslint(no-console)" } }
```

Switch rule without re-linting — edit the `filter.rule` value and save. Multi-rule: `"rule": ["eslint(no-undef)", "eslint(no-unused-vars)"]`.

To enable rules currently disabled in config before generating, flip them at the CLI level (`-D all` or targeted `-D rule-name`) rather than editing config files.

### Git churn (last N months)

```bash
git log --since='3 months ago' --numstat --pretty=format: \
  | awk '$1 != "-" && NF==3 { print $1 "\t" $2 "\t" $3 }' \
  | jq -Rn '[inputs | split("\t") | {
      additions: (.[0]|tonumber),
      deletions: (.[1]|tonumber),
      total:     ((.[0]|tonumber) + (.[1]|tonumber)),
      path:      .[2]
    }]' \
  > "$RESOURCES/data.json"
```

```json
{ "title": "Churn (3mo)", "unit": "lines changed", "valueField": "total" }
```

Switch `valueField` to `"additions"` or `"deletions"` to see growth vs. deletion hotspots. Vendored files like `bun.lock` tend to dominate — filter or exclude by path prefix in your generator if they're noise.

### Bytes by language

```bash
git ls-files -z \
  | xargs -0 -I{} sh -c 'printf "%s\t%d\t%s\n" "$(file --mime-type -b "{}")" "$(wc -c < "{}")" "{}"' \
  | jq -Rn '[inputs | split("\t") | {language: .[0], bytes: (.[1]|tonumber), path: .[2]}]' \
  > "$RESOURCES/data.json"
```

```json
{
  "title": "TypeScript size",
  "unit": "bytes",
  "valueField": "bytes",
  "filter": { "language": "text/x-typescript" }
}
```

Switch `filter.language` to see each language's share without regenerating.

### Dependency sizes

Any tool producing `{path: "pkg/subpkg/leaf", size: N}` — the `path` encodes the dependency tree. Examples: bundle analyzer JSON → `jq`, or `du -ak node_modules` parsed into `{path, size}`.

## Customizing the HTML

Only fork when JSON config can't express what you need (custom color scheme, extra panels, different aggregation). **Copy to `/tmp/` — never into the project root:**

```bash
cp -r .agents/skills/treemap/resources /tmp/treemap-custom
# edit /tmp/treemap-custom/index.html
bun x vite /tmp/treemap-custom --port 5173
```

## What this skill doesn't do

- Doesn't produce a static HTML file — the page is served by vite dev server. Export by taking a screenshot in the browser.
- Doesn't support multiple metrics overlaid on one leaf (e.g. size AND churn shown as a split cell). Pick one metric via `valueField`.
- Doesn't watch source files to auto-regenerate `data.json`. Re-run the generator manually, or wrap it in any file watcher; vite picks up the rewrite automatically.
- Doesn't host the page publicly; it's localhost-only.

## Cleanup

Resources are read in place under `.agents/skills/treemap/resources/`. When done:

```bash
pkill -f "bun x vite"
rm .agents/skills/treemap/resources/{data,config}.json
```

If you forked into `/tmp/`, remove that directory too.
