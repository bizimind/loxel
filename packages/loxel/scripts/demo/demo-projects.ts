import { appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { $ } from "bun";

/** Where the demo projects live: outside every real project, kept between runs. */
export const DEMO_ROOT = resolve(homedir(), ".loxel-demo");

/** The worktree of a demo project's task (or of its default branch), as `wt` lays them out. */
export const demoWorktree = (project: string, task: string) =>
  resolve(DEMO_ROOT, project, ".worktrees", task);

const WT_CLI = resolve(import.meta.dirname, "../../../wt/src/cli.ts");

interface DemoTask {
  /** Worktree and branch name */
  name: string;
  /** Sidebar title: short, so the sidebar never truncates it */
  title: string;
  /** A real pull request whose head becomes this task's branch */
  pr?: number;
  /** Start a new branch from another task's branch instead of the default branch */
  from?: string;
  /** Nest under this task in the sidebar */
  parent?: string;
}

interface DemoProject {
  name: string;
  url: string;
  /** Its default branch, whose worktree `wt init --main-worktree` creates */
  defaultBranch: string;
  /** Clone without blobs, fetching them only for what's checked out (large repositories) */
  partial?: boolean;
  tasks: DemoTask[];
}

/**
 * The projects the site's screenshots show: Loxel itself, each task a real PR branch, so a diff
 * on screen and the PR open in the browser are the same change; and Excalidraw, which Loxel
 * embeds, on an open PR that makes its point handles follow the embedder's selection color.
 */
export const DEMO_PROJECTS: DemoProject[] = [
  {
    name: "loxel",
    url: "https://github.com/bizimind/loxel.git",
    defaultBranch: "main",
    tasks: [
      { name: "maximize-group", title: "Maximize a group", pr: 1083 },
      {
        name: "maximize-shortcut",
        title: "Shortcut + palette",
        from: "maximize-group",
        parent: "maximize-group",
      },
      {
        name: "maximize-tab-menu",
        title: "Tab menu entry",
        from: "maximize-group",
        parent: "maximize-group",
      },
      { name: "site-fonts", title: "Self-host site fonts", pr: 1155 },
      { name: "hard-refresh", title: "Hard-refresh tabs", pr: 1052 },
      { name: "window-tiling", title: "Window tiling keys", pr: 1106 },
      {
        name: "tiling-menu",
        title: "Window menu roles",
        from: "window-tiling",
        parent: "window-tiling",
      },
      {
        name: "tiling-docs",
        title: "Shortcut docs",
        from: "window-tiling",
        parent: "window-tiling",
      },
      { name: "worktree-toast", title: "Worktree error toast", pr: 1107 },
      { name: "feature-tour", title: "Screenshots with soul" },
    ],
  },
  {
    name: "excalidraw",
    url: "https://github.com/excalidraw/excalidraw.git",
    defaultBranch: "master",
    partial: true,
    tasks: [{ name: "selection-color", title: "Selection color handles", pr: 11006 }],
  },
];

/** Worktrees that need their dependencies: tests, language servers and dev servers run there. */
export const INSTALL_IN = { loxel: ["main", "maximize-group", "site-fonts"] } as const;

async function wt(cwd: string, ...args: string[]): Promise<string> {
  return (await $`bun ${WT_CLI} ${args}`.cwd(cwd).quiet()).stdout.toString();
}

function isAddedWorktree(value: unknown): value is { path: string; meta: { "wt-id": string } } {
  if (typeof value !== "object" || value === null) return false;
  const { path, meta } = value as { path?: unknown; meta?: unknown };
  return (
    typeof path === "string" &&
    typeof meta === "object" &&
    meta !== null &&
    typeof (meta as Record<string, unknown>)["wt-id"] === "string"
  );
}

/** Clone a project bare, set up for `wt`, with its default branch and one worktree per task. */
async function createProject(project: DemoProject): Promise<Record<string, string>> {
  const dir = resolve(DEMO_ROOT, project.name);
  const filter = project.partial ? ["--filter=blob:none"] : [];
  await $`git clone --quiet --bare ${filter} ${project.url} ${dir}`.quiet();
  await wt(dir, "init", "--yes", "--main-worktree", "--worktree-metadata", "on");

  const paths: Record<string, string> = {
    [project.defaultBranch]: demoWorktree(project.name, project.defaultBranch),
  };
  const ids: Record<string, string> = {};
  for (const task of project.tasks) {
    const args = ["add", task.name, "--json", "--meta", `loxel-title=${task.title}`];
    if (task.pr !== undefined) {
      await $`git fetch --quiet origin ${`pull/${task.pr}/head:refs/heads/${task.name}`}`
        .cwd(dir)
        .quiet();
      args.push("--branch", task.name);
    } else if (task.from) {
      args.push("--base", task.from);
    }
    const parentId = task.parent && ids[task.parent];
    if (parentId) args.push("--meta", `loxel-parent-wt=${parentId}`);
    const added: unknown = JSON.parse(await wt(dir, ...args));
    if (!isAddedWorktree(added)) throw new Error(`wt add ${task.name} printed no path and wt-id`);
    paths[task.name] = added.path;
    ids[task.name] = added.meta["wt-id"];
  }
  return paths;
}

/** The drawing the browser shot shows, in the Excalidraw task's worktree. */
export const HANDLES_DRAWING = "handles.excalidraw";

/** The drawing's layout, in scene units. */
export const HANDLES_LAYOUT = { boxWidth: 320, boxHeight: 120, gap: 260, bulge: 80, inset: 34 };

/**
 * The drawing beside the PR, stacked to fill a tall, narrow pane: the two boxes the PR brings
 * together and an arrow between them, whose point handles are what the PR recolors. Excalidraw's
 * dark theme inverts the drawing (invert 93%, hue-rotate 180°), so it is stored in light colors
 * that turn into dark ones on screen. The browser shot rewrites it on every run, which undoes any
 * autosaved change.
 */
export function handlesDrawing(): string {
  const { boxWidth, boxHeight, gap, bulge, inset } = HANDLES_LAYOUT;
  const base = {
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    seed: 1,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    updated: 1,
    link: null,
    locked: false,
  };
  const box = (id: string, y: number, label: string, color: string) => [
    {
      ...base,
      id,
      type: "rectangle",
      x: 0,
      y,
      width: boxWidth,
      height: boxHeight,
      roundness: { type: 3 },
      backgroundColor: color,
      boundElements: [
        { type: "text", id: `${id}-label` },
        { type: "arrow", id: "fix" },
      ],
    },
    {
      ...base,
      id: `${id}-label`,
      type: "text",
      x: 20,
      y: y + boxHeight / 2 - 15,
      width: boxWidth - 40,
      height: 30,
      text: label,
      originalText: label,
      fontSize: 24,
      fontFamily: 5,
      textAlign: "center",
      verticalAlign: "middle",
      containerId: id,
      lineHeight: 1.25,
      autoResize: true,
      roundness: null,
      boundElements: [],
    },
  ];
  const elements = [
    ...box("selection", 0, "--color-selection", "#a5d8ff"),
    ...box("handles", boxHeight + gap, "point handles", "#d0bfff"),
    {
      ...base,
      id: "fix",
      type: "arrow",
      x: boxWidth / 2,
      y: boxHeight + inset,
      width: bulge,
      height: gap - 2 * inset,
      points: [
        [0, 0],
        [-bulge, gap / 2 - inset],
        [0, gap - 2 * inset],
      ],
      roundness: { type: 2 },
      startBinding: { elementId: "selection", focus: 0, gap: inset },
      endBinding: { elementId: "handles", focus: 0, gap: inset },
      startArrowhead: null,
      endArrowhead: "arrow",
      boundElements: [],
    },
    {
      ...base,
      id: "note",
      type: "text",
      x: boxWidth / 2 + 30,
      y: boxHeight + gap / 2 - 12,
      width: 190,
      height: 25,
      text: "same color, finally",
      originalText: "same color, finally",
      fontSize: 20,
      fontFamily: 5,
      textAlign: "left",
      verticalAlign: "top",
      containerId: null,
      lineHeight: 1.25,
      autoResize: true,
      roundness: null,
      boundElements: [],
      strokeColor: "#868e96",
    },
  ];
  return JSON.stringify(
    {
      type: "excalidraw",
      version: 2,
      source: "https://bizimind.io",
      elements,
      appState: { viewBackgroundColor: "transparent" },
      files: {},
    },
    null,
    2,
  );
}

/** The plan the markdown shot shows, in the feature-tour task's worktree. */
export const FEATURE_TOUR_FILE = "packages/site/feature-tour.md";

/** The plan in the markdown shot: the plan for the very page these screenshots are for. */
const FEATURE_TOUR_PLAN = `# Site: feature tour

Replace the single hero screenshot with a tour: one section per capability, each a real window capture beside the line that says why it matters.

## Shots

| Shot | Task | The point |
| --- | --- | --- |
| Worktrees | Maximize a group, Hard-refresh tabs | Every task keeps its own layout |
| Agents | Self-host site fonts | Your agents, in real terminals |
| Browser | Selection color handles | The PR and the change, side by side |
| Git | Worktree error toast | See what's landing |
| Editor | main | A glance beats asking |
| Markdown | Screenshots with soul | Plans next to the code |

## Rules

- Real code, real PRs, real agents. Nothing on screen that the task wouldn't have open.
- Dark everywhere: no white page flashes in a dark window.
- Short task titles; nobody likes an ellipsis.

## Checklist

- [x] Clone Loxel and Excalidraw into the demo
- [x] Check out each task from its real PR
- [x] Hand two agents a real question each
- [ ] Ask Excalidraw to merge #11006
- [x] Take a screenshot of this plan
`;

/**
 * Recreate the demo projects in DEMO_ROOT and add the files the shots show. Returns each
 * project's worktree paths by task name.
 */
export async function createDemoProjects(): Promise<Record<string, Record<string, string>>> {
  await $`rm -rf ${DEMO_ROOT}`.quiet();
  await $`mkdir -p ${DEMO_ROOT}`.quiet();
  const worktrees: Record<string, Record<string, string>> = {};
  for (const project of DEMO_PROJECTS) worktrees[project.name] = await createProject(project);

  await Bun.write(
    resolve(demoWorktree("excalidraw", "selection-color"), HANDLES_DRAWING),
    handlesDrawing(),
  );
  await Bun.write(
    resolve(demoWorktree("loxel", "feature-tour"), FEATURE_TOUR_FILE),
    FEATURE_TOUR_PLAN,
  );

  // Files the demo adds stay out of the tasks' changes, so no "untracked" count shows.
  for (const [project, file] of [
    ["excalidraw", HANDLES_DRAWING],
    ["loxel", FEATURE_TOUR_FILE],
  ] as const) {
    await $`mkdir -p ${resolve(DEMO_ROOT, project, "info")}`.quiet();
    await appendFile(resolve(DEMO_ROOT, project, "info/exclude"), `/${file}\n`);
  }

  // Loxel's `.envrc` is the repo's own; allowed, so its terminals don't open with direnv's warning.
  for (const dir of Object.values(worktrees.loxel ?? {})) {
    await $`direnv allow ${dir}`.quiet().nothrow();
  }

  for (const [project, names] of Object.entries(INSTALL_IN)) {
    for (const name of names) {
      await $`pnpm install --frozen-lockfile --ignore-scripts`
        .cwd(demoWorktree(project, name))
        .quiet();
    }
  }
  return worktrees;
}
