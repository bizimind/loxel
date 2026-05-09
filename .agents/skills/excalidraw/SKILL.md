---
name: excalidraw
description: Generate architecture diagrams as .excalidraw files from codebase analysis. Use when the user asks to create architecture diagrams, system diagrams, visualize codebase structure, generate excalidraw files or describe flows visually.
---

# Excalidraw Diagram Generator

Generate architecture diagrams as `.excalidraw` files directly from codebase analysis, using the `excalidraw` CLI for all diagram operations and PNG export.

---

## Quick Start

**User just asks:**

```
"Generate an architecture diagram for this project"
"Create an excalidraw diagram of the system"
"Visualize this codebase as an excalidraw file"
```

**Claude Code will** iteratively explore the codebase and build the diagram in parallel — starting rough, rendering often, and refining continuously.

**No prerequisites:** Works without existing diagrams, Terraform, or specific file types.

---

## CLI Overview

The `excalidraw` CLI handles all diagram creation and editing. It manages element structure, arrow bindings, bound text creation, and positioning automatically — never edit the raw JSON directly.

### Why CLI over raw JSON

- **Text**: `--text "Text"` creates the shape + bound text element pair automatically

- **Arrows**: `--from id --to id` calculates edge points, bindings, and positions

- **Diamonds**: Work correctly (broken in raw JSON due to rendering offsets)

- **Named IDs**: `--id name` gives human-readable, stable references

- **Cascade delete**: Removing a shape auto-removes its bound text and connected arrows

- **Batch**: Atomic multi-element operations with back-references (`$0`, `$1`)

- **Piping**: `query --ids | delete` for composable element operations

### Commands

| Command                 | Description                                                    |
| ----------------------- | -------------------------------------------------------------- |
| `create`                | Create a new .excalidraw file                                  |
| `draw rect/ellipse/...` | Create shapes with `--text`, `--id`, position, and styling     |
| `draw arrow`            | Connect shapes with `--from`/`--to` (auto-calculates bindings) |
| `edit <id>`             | Change colors, text, stroke, opacity                           |
| `move [ids...]`         | Move by offset (`--dx`/`--dy`) or absolute (`--to-x`/`--to-y`) |
| `resize <id>`           | Resize by dimensions or scale factor                           |
| `delete [ids...]`       | Remove elements (cascades to bound text and arrows by default) |
| `group <ids...>`        | Group elements together                                        |
| `ungroup <groupId>`     | Dissolve a group                                               |
| `query [ids...]`        | List, filter, and traverse elements                            |
| `batch`                 | Execute multiple commands atomically from JSON stdin           |
| `import mermaid`        | Import mermaid flowchart from stdin                            |
| `import table`          | Import CSV/markdown table as rectangle grid                    |
| `view`                  | Render to PNG for visual inspection                            |
| `lint`                  | Check for structural issues                                    |

---

## Named IDs

Always use `--id <name>` when creating elements. Named IDs are human-readable, stable across sessions, and make all subsequent operations clearer.

```bash
excalidraw -f d.excalidraw draw rect --id api-server -x 0 -y 0 -w 200 -h 100 --text "API Server"
excalidraw -f d.excalidraw draw rect --id database -x 0 -y 200 -w 200 -h 100 --text "PostgreSQL"
excalidraw -f d.excalidraw draw arrow --from api-server --to database --text "SQL"
```

In batch operations, use `--id` for elements you'll reference later, and `$N` back-references for inline connections:

```bash
echo '[
  {"command":"draw","type":"rect","id":"api","x":0,"y":0,"width":200,"height":100,"text":"API Server"},
  {"command":"draw","type":"rect","id":"db","x":0,"y":200,"width":200,"height":100,"text":"PostgreSQL"},
  {"command":"draw","type":"rect","id":"cache","x":300,"y":0,"width":200,"height":100,"text":"Redis Cache"},
  {"command":"draw","type":"arrow","from":"api","to":"db","text":"SQL"},
  {"command":"draw","type":"arrow","from":"api","to":"cache","text":"GET/SET"}
]' | excalidraw -f d.excalidraw batch
```

---

## Query and Piping

The `query` command finds elements by type, text content, or graph connectivity. Combined with `--ids`, it pipes element IDs to other commands.

### List and filter

```bash
excalidraw -f d.excalidraw query                          # List all elements
excalidraw -f d.excalidraw query --type rectangle         # Filter by type
excalidraw -f d.excalidraw query --text "API*"            # Glob match on text content
excalidraw -f d.excalidraw query api-server database      # Look up specific IDs
```

### Graph traversal

```bash
# Find everything connected to api-server (depth 1)
excalidraw -f d.excalidraw query api-server --connected

# Follow outbound arrows only, up to 3 hops
excalidraw -f d.excalidraw query api-server --connected --direction out --depth 3
```

### Piping patterns

```bash
# Delete a subgraph: remove api-server and everything connected to it
excalidraw -f d.excalidraw query api-server --connected --ids | excalidraw -f d.excalidraw delete

# Render only a subgraph to PNG (auto-includes bound text)
excalidraw -f d.excalidraw query api-server --connected --ids | excalidraw -f d.excalidraw view

# Move all rectangles 100px right
excalidraw -f d.excalidraw query --type rectangle --ids | excalidraw -f d.excalidraw move --dx 100

# Delete all arrows (to redraw after rearranging)
excalidraw -f d.excalidraw query --type arrow --ids | excalidraw -f d.excalidraw delete
```

---

## Import Commands (Preferred for New Diagrams)

**Start with** **`import mermaid`** **whenever possible.** It is 5-10x more token-efficient than batch JSON and produces a complete diagram with automatic layout, arrow bindings, and node labels in a single command. Use `batch` and individual CLI commands for refinement after import.

### Mermaid flowcharts

```bash
echo 'flowchart TD
  A[API Server] --> B[Database]
  A --> C[Cache]
  B --> D[Backup]' | excalidraw -f d.excalidraw import mermaid
```

Only flowcharts (`graph`/`flowchart` with `TD`/`LR`/`RL`/`BT`) are supported. Node IDs from the mermaid definition become excalidraw element IDs, so `A`, `B`, `C`, `D` are immediately usable in `edit`/`move`/`resize` commands. Subgraphs become labeled rectangles. Edge labels (`-->|text|`) become arrow text.

**Token comparison**: A 5-node flowchart in mermaid is \~100 tokens vs \~500+ tokens as batch JSON.

### Mermaid limitations and refinement workflow

Mermaid's auto-layout is a **starting point**, not a final product. After import:

- **Move shapes** to improve spacing or alignment: `excalidraw -f d.excalidraw move A --to-x 200 --to-y 100`

- **Restyle** with colors, stroke styles: use batch `edit` commands

- **Delete and redraw arrows** if repositioning breaks paths: `query --type arrow --ids | delete`, then re-add with `draw arrow --from X --to Y`

- **Add elements** that don't exist in the mermaid syntax: legends, annotations, grouping rectangles, standalone text

Mermaid only supports rectangles, diamonds, and basic flowchart shapes. For ellipses, frames, or custom styling, add those after import.

### Combining multiple imports

Build complex diagrams by importing multiple mermaid diagrams into the same file with offsets, then connecting them:

```bash
# Import the frontend flow on the left
echo 'flowchart TD
  U[User] --> FE[React App]
  FE --> SSR[Next.js]' | excalidraw -f d.excalidraw import mermaid

# Import the backend flow on the right
echo 'flowchart TD
  API[API Gateway] --> Auth[Auth Service]
  API --> DB[(PostgreSQL)]' | excalidraw -f d.excalidraw import mermaid -x 400

# Connect across the two imports
excalidraw -f d.excalidraw draw arrow --from SSR --to API --text "REST"

# Style everything in one batch
echo '[
  {"command":"edit","id":"U","bg":"#a5d8ff"},
  {"command":"edit","id":"FE","bg":"#a5d8ff"},
  {"command":"edit","id":"SSR","bg":"#a5d8ff"},
  {"command":"edit","id":"API","bg":"#b2f2bb"},
  {"command":"edit","id":"Auth","bg":"#b2f2bb"},
  {"command":"edit","id":"DB","bg":"#ffec99"}
]' | excalidraw -f d.excalidraw batch
```

### Tables

```bash
echo 'Service,Port,Protocol
API,8080,HTTP
Auth,8081,gRPC
DB,5432,TCP' | excalidraw -f d.excalidraw import table
```

Accepts CSV or markdown table format (auto-detected). Header row gets a blue background. Cell IDs follow `r{row}c{col}` pattern: `r0c0` is top-left header cell.

**Options**: `--cell-width <n>` (fixed width, otherwise auto), `--cell-height <n>` (default 40), `--header-bg <color>` (default `#a5d8ff`), `-x`/`-y` (offset).

Tables can be combined with flowcharts — import a mermaid diagram for the architecture, then add a reference table below with `-y` offset.

---

## Element Types

| Type        | Use For                                        |
| ----------- | ---------------------------------------------- |
| `rectangle` | Services, databases, containers, orchestrators |
| `ellipse`   | Users, external systems, start/end points      |
| `diamond`   | Decision points, routers, hubs                 |
| `text`      | Titles, annotations (standalone)               |
| `arrow`     | Data flow, connections, dependencies           |
| `line`      | Grouping boundaries, separators                |
| `frame`     | Frame containers with named sections           |

---

## Approach: Iterative Refinement

**Do not try to plan the entire diagram upfront.** Build it incrementally — explore the code, add a few shapes, render, rearrange, explore more code, add more detail, render again. The diagram and your understanding of the codebase should evolve together.

**Core loop:** CLI commands -> `excalidraw view` -> read PNG -> refine -> repeat.

Start rough and imprecise. Positions, colors, and groupings will change as you learn more about the code. That's expected. A wrong shape in the right place is better than no diagram while you're still planning.

### Rendering and visual verification

**Render after every few changes.** Never make many blind edits then check once at the end. Visual issues — arrows overlapping text, shapes hiding behind other shapes, text wrapping unexpectedly, crowded labels — are easy to spot in a PNG but impossible to catch from JSON data.

```bash
excalidraw -f diagram.excalidraw view --scale 2
# Read the PNG to visually inspect, then continue editing
```

**Always use** **`view`** **to verify the final result.** Check for:

- Arrows crossing over or hiding text/shapes

- Text wrapping inside containers (resize or shorten labels)

- Overlapping elements (move shapes to add spacing)

- Missing connections or labels

### Choosing a starting method

**Use** **`import mermaid`** when the diagram is a node-and-edge flowchart and you know the structure upfront. This is 5-10x more token-efficient than batch JSON and produces automatic layout with arrow bindings. Good for: architecture overviews, data flows, dependency graphs.

**Use** **`batch`** when you need precise positioning, custom shapes (ellipses, frames), mixed element types, or when the diagram doesn't fit a flowchart structure. Good for: free-form layouts, sequence-like diagrams, annotated designs.

**Use individual commands** for incremental additions to an existing diagram.

### Building with mermaid import

```bash
echo 'flowchart TD
  FE[React App] --> API[API Server]
  API --> DB[(PostgreSQL)]
  API --> Cache[Redis]' | excalidraw -f d.excalidraw import mermaid

excalidraw -f d.excalidraw view --scale 2
# Inspect, then restyle and refine
echo '[
  {"command":"edit","id":"FE","bg":"#a5d8ff","stroke":"#1971c2"},
  {"command":"edit","id":"API","bg":"#b2f2bb","stroke":"#2f9e44"},
  {"command":"edit","id":"DB","bg":"#ffec99","stroke":"#e8590c"},
  {"command":"edit","id":"Cache","bg":"#ffe3e3","stroke":"#c92a2a"}
]' | excalidraw -f d.excalidraw batch
excalidraw -f d.excalidraw view --scale 2
```

### Building with batch

```bash
echo '[
  {"command":"draw","type":"rect","id":"frontend","x":100,"y":100,"width":200,"height":100,"text":"React App","bg":"#a5d8ff","stroke":"#1971c2"},
  {"command":"draw","type":"rect","id":"api","x":100,"y":300,"width":200,"height":100,"text":"API Server","bg":"#b2f2bb","stroke":"#2f9e44"},
  {"command":"draw","type":"rect","id":"db","x":100,"y":500,"width":200,"height":100,"text":"PostgreSQL","bg":"#ffec99","stroke":"#e8590c"},
  {"command":"draw","type":"arrow","from":"frontend","to":"api","text":"REST"},
  {"command":"draw","type":"arrow","from":"api","to":"db","text":"SQL"}
]' | excalidraw -f diagram.excalidraw batch
excalidraw -f diagram.excalidraw view --scale 2
```

### Incremental additions

```bash
excalidraw -f d.excalidraw draw rect --id cache -x 400 -y 300 -w 200 -h 100 --text "Redis" --bg "#ffe3e3"
excalidraw -f d.excalidraw draw arrow --from api --to cache --text "GET/SET"
excalidraw -f d.excalidraw view --scale 2
```

### Bulk edits with jq

For operations the CLI doesn't cover (bulk recolor by type, position-based shifts), use `jq` on the raw JSON:

```bash
# Shift everything below y=400 down by 200px
jq '(.elements[] | select(.y >= 400)).y += 200' f.excalidraw > tmp && mv tmp f.excalidraw

# Recolor all rectangles
jq '(.elements[] | select(.type == "rectangle")).backgroundColor = "#e3f2fd"' f.excalidraw > tmp && mv tmp f.excalidraw
```

**Full jq reference:** See `references/jq-operations.md`

### Codebase Discovery

Explore the code as you build — don't try to map everything before drawing. Use tools to discover components incrementally:

- `Glob` -> `**/package.json`, `**/Dockerfile`, `**/*.tf`

- `Grep` -> `app.get`, `@Controller`, `CREATE TABLE`

- `Read` -> README, config files, entry points

| Codebase Type | What to Look For                             |
| ------------- | -------------------------------------------- |
| Monorepo      | `packages/*/package.json`, workspace configs |
| Microservices | `docker-compose.yml`, k8s manifests          |
| IaC           | Terraform/Pulumi resource definitions        |
| Backend API   | Route definitions, controllers, DB models    |
| Frontend      | Component hierarchy, API calls               |

### Grouping

For logical groupings, use a large transparent dashed rectangle with a standalone text label:

```bash
excalidraw -f d.excalidraw draw rect --id group-data -x 50 -y 450 -w 500 -h 250 \
  --stroke "#9c36b5" --bg transparent --stroke-style dashed --roughness 0
excalidraw -f d.excalidraw draw text "Data Layer" --id group-data-label -x 70 -y 460 \
  --font-size 14 --font-family normal
```

### Validation

Run `excalidraw -f <file> lint` to check for structural issues (binding integrity, arrow connections, duplicate IDs, bounding boxes).

Run `excalidraw -f <file> query` to review all elements at a glance.

---

## Token Efficiency

Excalidraw JSON files are verbose — a 10-element diagram can be 5000+ tokens. Follow these rules to minimize token waste:

### 1. Use `import mermaid` instead of batch JSON for new diagrams

This is the single biggest token saving. A mermaid definition is 5-10x more compact than equivalent batch JSON and produces a complete diagram with layout, bindings, and labels.

```bash
# ~80 tokens: mermaid import
echo 'flowchart TD; A[API]-->B[DB]; A-->C[Cache]' | excalidraw -f d.excalidraw import mermaid

# ~500 tokens: equivalent batch JSON (avoid for initial creation)
echo '[{"command":"draw","type":"rect","id":"A","x":0,"y":0,...},...]' | excalidraw -f d.excalidraw batch
```

### 2. Never read the full `.excalidraw` file

```bash
# BAD: reads entire file into context (thousands of wasted tokens)
cat diagram.excalidraw
Read diagram.excalidraw

# GOOD: use query for a compact summary
excalidraw -f d.excalidraw query

# GOOD: use jq to extract specific fields
jq '[.elements[] | select(.isDeleted != true) | {id, type, x, y}]' d.excalidraw
```

### 3. Use `query` to inspect diagrams

```bash
excalidraw -f d.excalidraw query                                    # All elements
excalidraw -f d.excalidraw query --type rectangle                   # Filter by type
excalidraw -f d.excalidraw query --text "API*"                      # Glob match
excalidraw -f d.excalidraw query api-server --connected --depth 2   # Graph traversal
```

### 4. Use `import table` for tabular data

```bash
printf 'Name,Port\nAPI,8080\nDB,5432' | excalidraw -f d.excalidraw import table
```

---

## Reference Files

| File                          | Contents                                    |
| ----------------------------- | ------------------------------------------- |
| `references/examples.md`      | CLI batch examples and layout patterns      |
| `references/jq-operations.md` | Bulk editing with jq (complementary to CLI) |
| `references/export.md`        | PNG rendering and piping with view          |
| `references/arrows.md`        | Arrow styling and arrowhead options         |
| `references/json-format.md`   | Excalidraw JSON structure (read-only ref)   |
| `references/validate.md`      | Lint command and query-based verification   |
| `references/troubleshoot.md`  | Common issues and fixes                     |

---

## Output

- **Location:** `docs/architecture/` or user-specified

- **Filename:** Descriptive, e.g., `system-architecture.excalidraw`

- **Verification:** Render with `excalidraw -f <file> view --scale 2` and inspect the PNG

- **Interactive editing:** Open `.excalidraw` in <https://excalidraw.com> or the VS Code Excalidraw extension
