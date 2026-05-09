#!/usr/bin/env bun
import {
  Command,
  createUpdateCommand,
  createVersionCommand,
  type UpdateConfig,
} from "@bizimind/cli-common";
import { Option } from "commander";

import { getCurrentVersion } from "./version.ts";

function requireFile(): string {
  const file = program.opts().file as string | undefined;
  if (!file) {
    process.stderr.write("Error: required option '-f, --file <path>' not specified\n");
    process.exit(1);
  }
  return file;
}

const program = new Command()
  .name("excalidraw")
  .description(
    `Create and edit Excalidraw diagrams from the command line.

WORKFLOW: Create a file with 'create', add shapes with 'draw', inspect with
'view', then refine with 'edit', 'move', and 'resize'. Use 'batch' to send
multiple commands at once for efficiency.

TIP: Always use 'view' to verify your work visually. Do not rely on coordinates
alone — render and inspect the result to understand how the diagram actually looks.

PIPING: Commands accept IDs via stdin. Use 'query --ids' to output IDs for
piping into move, delete, or view. Also works with jq on the .excalidraw file.

EXAMPLES:
  excalidraw create -f diagram.excalidraw
  excalidraw -f diagram.excalidraw draw rect --id auth -w 200 -h 100 --text "Auth"
  excalidraw -f diagram.excalidraw query auth --connected --depth 2
  excalidraw -f diagram.excalidraw view`,
  )
  .version(getCurrentVersion())
  .option("-f, --file <path>", "Path to .excalidraw file");

// --- create ---
program
  .command("create")
  .description(
    `Create a new .excalidraw file.

Creates an empty diagram file. This must be done before using other commands.

EXAMPLES:
  excalidraw create -f diagram.excalidraw
  excalidraw create -f diagram.excalidraw --bg "#f5f5f5"`,
  )
  .option("--bg <color>", "Canvas background color", "#ffffff")
  .option("--force", "Overwrite if file already exists")
  .option("-j, --json", "Output as JSON")
  .action(async (opts) => {
    const { createCommand } = await import("./commands/create.ts");
    await createCommand(requireFile(), opts);
  });

// --- draw ---
const draw = program.command("draw").description(
  `Create shapes on the canvas.

Use subcommands to create specific shape types. Each command returns the
element ID which you can use with edit, move, resize, and delete.

SHAPES: rect, ellipse, diamond, text, line, arrow, freedraw, frame

EXAMPLES:
  excalidraw -f d.excalidraw draw rect -x 0 -y 0 -w 200 -h 100 --text "Box"
  excalidraw -f d.excalidraw draw arrow --from abc123 --to def456
  excalidraw -f d.excalidraw draw text "Hello World" --font-size 28`,
);

function addCommonShapeOptions(cmd: Command): Command {
  return cmd
    .option("--id <name>", "Custom element ID (must be unique in file)")
    .option("-x, --x <n>", "X position", parseFloat, 0)
    .option("-y, --y <n>", "Y position", parseFloat, 0)
    .option("--stroke <color>", "Stroke color", "#1e1e1e")
    .option("--bg <color>", "Background color", "transparent")
    .option("--fill <style>", "Fill style: solid|hachure|cross-hatch|zigzag", "solid")
    .option("--stroke-width <n>", "Stroke width: 1|2|4", parseFloat, 2)
    .option("--stroke-style <s>", "Line style: solid|dashed|dotted", "solid")
    .option("--roughness <n>", "0=architect|1=artist|2=cartoonist", parseFloat, 1)
    .option("--opacity <n>", "Opacity 0-100", parseFloat, 100)
    .option("-j, --json", "Output as JSON");
}

function addContainerOptions(cmd: Command): Command {
  return addCommonShapeOptions(cmd)
    .option("-w, --width <n>", "Width", parseFloat)
    .option("-h, --height <n>", "Height", parseFloat)
    .option("--round <n>", "Corner roundness (0 = sharp)", parseFloat)
    .option("--text <content>", "Bound text inside shape")
    .option("--text-font-size <n>", "Bound text font size", parseFloat, 20);
}

addContainerOptions(
  draw.command("rect").description(
    `Create a rectangle.

EXAMPLES:
  excalidraw -f d.excalidraw draw rect -x 100 -y 50 -w 200 -h 100
  excalidraw -f d.excalidraw draw rect --text "My Box" --bg "#e3f2fd"
  excalidraw -f d.excalidraw draw rect --stroke-style dashed --round 10`,
  ),
).action(async (opts) => {
  const { drawShape } = await import("./commands/draw.ts");
  await drawShape("rectangle", requireFile(), opts);
});

addContainerOptions(
  draw.command("ellipse").description(
    `Create an ellipse (circle).

Default size is 200x200 (a circle). Use different width/height for an ellipse.

EXAMPLES:
  excalidraw -f d.excalidraw draw ellipse -x 300 -y 100
  excalidraw -f d.excalidraw draw ellipse -w 300 -h 150 --text "Node"`,
  ),
).action(async (opts) => {
  const { drawShape } = await import("./commands/draw.ts");
  await drawShape("ellipse", requireFile(), opts);
});

addContainerOptions(
  draw.command("diamond").description(
    `Create a diamond shape.

EXAMPLES:
  excalidraw -f d.excalidraw draw diamond -x 200 -y 200 --text "Decision"`,
  ),
).action(async (opts) => {
  const { drawShape } = await import("./commands/draw.ts");
  await drawShape("diamond", requireFile(), opts);
});

addCommonShapeOptions(
  draw
    .command("text")
    .argument("<content>", "The text content")
    .description(
      `Create a text element.

EXAMPLES:
  excalidraw -f d.excalidraw draw text "Hello World"
  excalidraw -f d.excalidraw draw text "Title" --font-size 36 --font-family normal`,
    ),
)
  .option("--font-size <n>", "Font size", parseFloat, 20)
  .option("--font-family <f>", "Font: hand|normal|code", "hand")
  .option("--text-align <a>", "Alignment: left|center|right", "left")
  .action(async (content: string, opts) => {
    const { drawText } = await import("./commands/draw.ts");
    await drawText(requireFile(), content, opts);
  });

addCommonShapeOptions(
  draw.command("line").description(
    `Create a line.

Points are relative to the element position. First point should be [0,0].

EXAMPLES:
  excalidraw -f d.excalidraw draw line -x 100 -y 100 --points '[[0,0],[200,100]]'
  excalidraw -f d.excalidraw draw line --points '[[0,0],[100,0],[100,100]]'`,
  ),
)
  .option("--points <json>", "Points array as JSON, e.g. '[[0,0],[200,0]]'")
  .action(async (opts) => {
    const { drawLinear } = await import("./commands/draw.ts");
    await drawLinear("line", requireFile(), opts);
  });

addCommonShapeOptions(
  draw.command("arrow").description(
    `Create an arrow. Arrows can be free-floating or bound to shapes.

BINDING: Use --from and --to to connect shapes. The arrow will automatically
compute positions from shape centers. When you move bound shapes later, the
connections are preserved. Use 'view' to verify arrow placement visually.

ARROWHEADS: none, arrow, bar, dot, triangle

EXAMPLES:
  excalidraw -f d.excalidraw draw arrow --from abc123 --to def456
  excalidraw -f d.excalidraw draw arrow -x 0 -y 0 --points '[[0,0],[200,100]]'
  excalidraw -f d.excalidraw draw arrow --from abc --to def --text "HTTP" --end-head triangle`,
  ),
)
  .option("--points <json>", "Points array as JSON")
  .option("--from <id>", "Bind start to element ID")
  .option("--to <id>", "Bind end to element ID")
  .option("--start-head <type>", "Start arrowhead: none|arrow|bar|dot|triangle", "none")
  .option("--end-head <type>", "End arrowhead: none|arrow|bar|dot|triangle", "arrow")
  .option("--text <content>", "Bound text on the arrow")
  .action(async (opts) => {
    const { drawArrow } = await import("./commands/draw.ts");
    await drawArrow(requireFile(), opts);
  });

addCommonShapeOptions(
  draw.command("freedraw").description(
    `Create a hand-drawn path.

EXAMPLES:
  excalidraw -f d.excalidraw draw freedraw --points '[[0,0],[10,5],[20,3],[30,8]]'`,
  ),
)
  .option("--points <json>", "Points array as JSON (required)")
  .action(async (opts) => {
    const { drawFreeDraw } = await import("./commands/draw.ts");
    await drawFreeDraw(requireFile(), opts);
  });

addCommonShapeOptions(
  draw.command("frame").description(
    `Create a frame container.

Frames visually group elements and clip their rendering. Use --children to
assign existing elements to the frame.

EXAMPLES:
  excalidraw -f d.excalidraw draw frame -w 800 -h 600 --name "Module A"
  excalidraw -f d.excalidraw draw frame --children "abc123,def456"`,
  ),
)
  .option("-w, --width <n>", "Width", parseFloat, 800)
  .option("-h, --height <n>", "Height", parseFloat, 600)
  .option("--name <text>", "Frame label")
  .option("--children <ids>", "Comma-separated element IDs to include")
  .action(async (opts) => {
    const { drawFrame } = await import("./commands/draw.ts");
    await drawFrame(requireFile(), opts);
  });

// --- query (replaces list) ---
program
  .command("query")
  .alias("q")
  .alias("list")
  .alias("ls")
  .argument("[ids...]", "Element IDs to look up or start traversal from")
  .description(
    `Query elements with filtering, lookup, and graph traversal.

Without IDs: lists all elements (like 'list').
With IDs: shows details for those elements.
With --connected: BFS traversal following arrow connections.

OUTPUT MODES:
  Default table, --json for structured data, --ids for pipe-friendly IDs.

PIPING: Accepts IDs from stdin (jq output, newline/comma-separated, JSON arrays,
or full element objects — the .id field is extracted automatically).

EXAMPLES:
  excalidraw -f d.excalidraw query
  excalidraw -f d.excalidraw query --type rectangle
  excalidraw -f d.excalidraw query auth --connected --depth 2
  excalidraw -f d.excalidraw query --text "Auth*" --ids
  excalidraw -f d.excalidraw query auth --connected --ids | excalidraw -f d.excalidraw delete`,
  )
  .option("--type <type>", "Filter by element type")
  .option("--text <pattern>", "Filter by text content (glob: * and ?)")
  .option("--connected", "BFS traversal following arrow connections")
  .option("--depth <n>", "Max traversal depth (default: 1)", parseFloat)
  .addOption(
    new Option("--direction <dir>", "Traversal direction")
      .choices(["in", "out", "both"])
      .default("both"),
  )
  .option("--ids", "Output newline-separated IDs (pipe-friendly)")
  .option("-j, --json", "Output as JSON")
  .action(async (ids: string[] | undefined, opts) => {
    const { queryCommand } = await import("./commands/query.ts");
    const { tryReadStdinIds } = await import("./commands/stdin-ids.ts");
    let seedIds: string[] = ids && ids.length > 0 ? ids : [];
    if (seedIds.length === 0) {
      seedIds = (await tryReadStdinIds()) ?? [];
    }
    await queryCommand(requireFile(), seedIds, opts);
  });

// --- view ---
program
  .command("view")
  .description(
    `Render the diagram to a PNG image for visual inspection.

Use this command frequently to verify your work. Do not rely on coordinates
alone — always render and inspect to understand how the diagram actually looks.

EXAMPLES:
  excalidraw -f d.excalidraw view
  excalidraw -f d.excalidraw view -o preview.png --scale 3`,
  )
  .option("-o, --output <path>", "Output PNG path (default: <input-basename>.png)")
  .option("--scale <n>", "Scale factor", parseFloat, 2)
  .option("--padding <n>", "Export padding in px", parseFloat, 20)
  .option("-j, --json", "Output as JSON")
  .action(async (opts) => {
    const { tryReadStdinIds } = await import("./commands/stdin-ids.ts");
    const filterIds = await tryReadStdinIds();
    const { viewCommand } = await import("./commands/view.ts");
    await viewCommand(requireFile(), { ...opts, filterIds });
  });

// --- edit ---
program
  .command("edit")
  .argument("<id>", "Element ID to edit")
  .description(
    `Modify element properties.

Change visual properties like colors, stroke, fill, or update text content.
Use 'list' to find element IDs, and 'view' after editing to verify changes.

EXAMPLES:
  excalidraw -f d.excalidraw edit abc123 --bg "#e3f2fd" --stroke "#1565c0"
  excalidraw -f d.excalidraw edit abc123 --text "Updated text"
  excalidraw -f d.excalidraw edit abc123 --stroke-style dashed --opacity 50`,
  )
  .option("--stroke <color>", "Stroke color")
  .option("--bg <color>", "Background color")
  .option("--fill <style>", "Fill style")
  .option("--stroke-width <n>", "Stroke width", parseFloat)
  .option("--stroke-style <s>", "Line style")
  .option("--roughness <n>", "Roughness", parseFloat)
  .option("--opacity <n>", "Opacity 0-100", parseFloat)
  .option("--round <n>", "Corner roundness", parseFloat)
  .option("--text <content>", "Text content (text elements and containers)")
  .option("--font-size <n>", "Font size (text elements)", parseFloat)
  .option("--font-family <f>", "Font: hand|normal|code (text elements)")
  .option("--locked", "Lock element")
  .option("--unlocked", "Unlock element")
  .option("-j, --json", "Output as JSON")
  .action(async (id: string, opts) => {
    const { editCommand } = await import("./commands/edit.ts");
    await editCommand(requireFile(), id, opts);
  });

// --- move ---
program
  .command("move")
  .argument("[ids...]", "Element IDs to move (also accepts group IDs, or pipe via stdin)")
  .description(
    `Move elements by offset or to an absolute position.

Use --dx/--dy for relative moves, or --to-x/--to-y for absolute positioning.
When moving multiple elements, relative offsets apply to all. For absolute
positioning, the first element is placed at the target and others maintain
their relative offsets.

PIPING: Accepts IDs from stdin when no IDs are given as arguments.

EXAMPLES:
  excalidraw -f d.excalidraw move abc123 --dx 100 --dy 50
  excalidraw -f d.excalidraw move abc123 def456 --dx -50 --dy 0
  excalidraw -f d.excalidraw move abc123 --to-x 400 --to-y 200
  jq -r '...' d.excalidraw | excalidraw -f d.excalidraw move --dx 100`,
  )
  .option("--dx <n>", "Relative X offset", parseFloat)
  .option("--dy <n>", "Relative Y offset", parseFloat)
  .option("--to-x <n>", "Absolute X position", parseFloat)
  .option("--to-y <n>", "Absolute Y position", parseFloat)
  .option("-j, --json", "Output as JSON")
  .action(async (ids: string[], opts) => {
    const { resolveIds } = await import("./commands/stdin-ids.ts");
    const resolvedIds = await resolveIds(ids);
    const { moveCommand } = await import("./commands/move.ts");
    await moveCommand(requireFile(), resolvedIds, opts);
  });

// --- resize ---
program
  .command("resize")
  .argument("<id>", "Element ID to resize")
  .description(
    `Resize an element by dimensions or scale factor.

EXAMPLES:
  excalidraw -f d.excalidraw resize abc123 -w 300 -h 200
  excalidraw -f d.excalidraw resize abc123 --scale 1.5`,
  )
  .option("-w, --width <n>", "New width", parseFloat)
  .option("-h, --height <n>", "New height", parseFloat)
  .option("--scale <n>", "Scale factor (e.g. 1.5 for 150%)", parseFloat)
  .option("-j, --json", "Output as JSON")
  .action(async (id: string, opts) => {
    const { resizeCommand } = await import("./commands/resize.ts");
    await resizeCommand(requireFile(), id, opts);
  });

// --- delete ---
program
  .command("delete")
  .alias("rm")
  .argument("[ids...]", "Element IDs to delete (or pipe via stdin)")
  .description(
    `Delete elements from the diagram.

By default, also deletes bound text elements and connected arrows (cascade).
Use --no-cascade to skip, or --no-cascade-arrows / --no-cascade-text
for finer control.

PIPING: Accepts IDs from stdin when no IDs are given as arguments.

EXAMPLES:
  excalidraw -f d.excalidraw delete abc123
  excalidraw -f d.excalidraw delete abc123 --no-cascade
  excalidraw -f d.excalidraw query auth --connected --ids | excalidraw -f d.excalidraw delete`,
  )
  .option("--no-cascade", "Skip cascade deletion of bound text and arrows")
  .option("--no-cascade-arrows", "Keep connected arrows when deleting")
  .option("--no-cascade-text", "Keep bound text elements when deleting")
  .option("-j, --json", "Output as JSON")
  .action(async (ids: string[], opts) => {
    const { resolveIds } = await import("./commands/stdin-ids.ts");
    const resolvedIds = await resolveIds(ids);
    const { deleteCommand } = await import("./commands/delete.ts");
    await deleteCommand(requireFile(), resolvedIds, opts);
  });

// --- group ---
program
  .command("group")
  .argument("<ids...>", "Element IDs to group (minimum 2)")
  .description(
    `Group elements together.

Grouped elements can be moved together. Returns a group ID for use with
ungroup or move commands.

EXAMPLES:
  excalidraw -f d.excalidraw group abc123 def456
  excalidraw -f d.excalidraw group abc123 def456 ghi789`,
  )
  .option("-j, --json", "Output as JSON")
  .action(async (ids: string[], opts) => {
    const { groupCommand } = await import("./commands/group.ts");
    await groupCommand(requireFile(), ids, opts);
  });

// --- ungroup ---
program
  .command("ungroup")
  .argument("<groupId>", "Group ID to dissolve")
  .description(
    `Remove a group, leaving elements independent.

EXAMPLES:
  excalidraw -f d.excalidraw ungroup grp_abc123`,
  )
  .option("-j, --json", "Output as JSON")
  .action(async (groupId: string, opts) => {
    const { ungroupCommand } = await import("./commands/group.ts");
    await ungroupCommand(requireFile(), groupId, opts);
  });

// --- batch ---
program
  .command("batch")
  .description(
    `Execute multiple commands from a JSON array on stdin.

This is the most efficient way to build complex diagrams. The file is loaded
once, all operations are applied in sequence, and the file is saved once.

BACK-REFERENCES: Use "$0", "$1", etc. to reference the ID returned by the
Nth command (0-indexed). Use "$N.text" for the bound text element ID.

SUPPORTED COMMANDS: draw, edit, move, resize, group, ungroup, delete

EXAMPLE:
  echo '[
    {"command":"draw","type":"rect","x":0,"y":0,"width":200,"height":100,"text":"A"},
    {"command":"draw","type":"rect","x":400,"y":0,"width":200,"height":100,"text":"B"},
    {"command":"draw","type":"arrow","from":"$0","to":"$1"},
    {"command":"edit","id":"$0","bg":"#e3f2fd"}
  ]' | excalidraw -f diagram.excalidraw batch`,
  )
  .option("-j, --json", "Output as JSON")
  .action(async (opts) => {
    const { batchCommand } = await import("./commands/batch.ts");
    await batchCommand(requireFile(), opts);
  });

// --- lint ---
program
  .command("lint")
  .description(
    `Check the diagram for structural issues.

Validates binding integrity, arrow connections, duplicate IDs, and bounding
boxes. Use this to catch problems that may not be visible in the rendering.`,
  )
  .option("-j, --json", "Output as JSON")
  .action(async (opts) => {
    const { lintCommand } = await import("./commands/lint.ts");
    await lintCommand(requireFile(), opts);
  });

// --- import ---
const imp = program.command("import").description(
  `Import diagrams from other formats.

Reads input from stdin. Creates elements in the target file.

SUBCOMMANDS: mermaid, table

EXAMPLES:
  echo 'flowchart TD; A-->B' | excalidraw -f d.excalidraw import mermaid
  cat data.csv | excalidraw -f d.excalidraw import table`,
);

imp
  .command("mermaid")
  .description(
    `Import a Mermaid flowchart diagram from stdin.

Converts mermaid syntax to native excalidraw elements with automatic layout.
Node IDs from the mermaid definition become element IDs in the diagram.

Only flowchart/graph diagrams produce editable elements. Other types
(sequence, class, ER) are not supported.

EXAMPLES:
  echo 'flowchart TD
    A[API Server] --> B[Database]
    A --> C[Cache]' | excalidraw -f d.excalidraw import mermaid

  cat flow.mmd | excalidraw -f d.excalidraw import mermaid -x 100 -y 100`,
  )
  .option("-x, --x <n>", "X offset for imported elements", parseFloat, 0)
  .option("-y, --y <n>", "Y offset for imported elements", parseFloat, 0)
  .option("-j, --json", "Output as JSON")
  .action(async (opts) => {
    const { importMermaidCommand } = await import("./commands/import-mermaid.ts");
    await importMermaidCommand(requireFile(), opts);
  });

imp
  .command("table")
  .description(
    `Import tabular data as a grid of rectangles from stdin.

Reads CSV or markdown table and creates a rectangle grid with text in each cell.
Auto-detects format: lines with | are markdown tables, otherwise CSV.
Cell IDs follow r{row}c{col} pattern (e.g., r0c0 for top-left).

EXAMPLES:
  echo 'Name,Role,Status
  Alice,Engineer,Active
  Bob,PM,Active' | excalidraw -f d.excalidraw import table

  cat data.md | excalidraw -f d.excalidraw import table --header-bg "#e3f2fd"`,
  )
  .option("-x, --x <n>", "X offset", parseFloat, 0)
  .option("-y, --y <n>", "Y offset", parseFloat, 0)
  .option("--cell-width <n>", "Fixed cell width (auto if not set)", parseFloat)
  .option("--cell-height <n>", "Cell height", parseFloat, 40)
  .option("--header-bg <color>", "Header row background color", "#a5d8ff")
  .option("-j, --json", "Output as JSON")
  .action(async (opts) => {
    const { importTableCommand } = await import("./commands/import-table.ts");
    await importTableCommand(requireFile(), opts);
  });

// --- version & update ---
const updateConfig: UpdateConfig = { packageName: "excalidraw", getCurrentVersion };
program.addCommand(createVersionCommand(updateConfig));
program.addCommand(createUpdateCommand(updateConfig));

program
  .parseAsync()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${message}\n`);
    process.exit(1);
  });
