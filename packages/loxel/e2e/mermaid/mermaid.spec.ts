/**
 * Renders real Mermaid diagrams in the markdown editor's code block preview (unit tests mock
 * mermaid), covering every diagram type and mermaid 12 opt-in Loxel documents, in both themes:
 * each block must render a diagram (never the error preview) with its light and dark variant,
 * and the opt-ins must change what they promise to while the default keeps mermaid 11's look.
 * Also checks Excalidraw's own mermaid import, which no longer brings a mermaid of its own.
 *
 * `MERMAID_SHOTS=<dir>` also writes each block's preview to `<dir>/<name>-<theme>.png`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, type Locator, type Page, test } from "@playwright/test";

import { useSettingsStore } from "@/store/settings-store";

import { waitForLoxel } from "../helpers/server";

interface Diagram {
  name: string;
  source: string;
  /** The rendered `<svg>`'s `aria-roledescription`. */
  role: string;
  /** Selectors that must match inside the light variant. */
  has?: string[];
  /** Selectors that must not match inside the light variant. */
  hasNot?: string[];
}

const LOOP = `A[Start] --> B{Ready?}
  B -->|yes| C[Ship it]
  B -->|no| D[Fix the build]
  D --> A`;

const STEPS = `flowchart LR
  Client e1@--> API
  API e2@--> Cache
  Cache e3@-->|miss| DB
  DB e4@--> API
  API e5@--> Client
  e1@{ step: 1 }
  e2@{ step: 2 }
  e3@{ step: 3 }
  e4@{ step: 4 }
  e5@{ step: 5 }`;

const MINDMAP = `mindmap
  root((Release))
    Build
      Compile
      Sign
    Ship
      Upload
      Announce`;

const DIAGRAMS: Diagram[] = [
  {
    name: "flowchart",
    source: `flowchart LR\n  ${LOOP}`,
    role: "flowchart-v2",
    hasNot: ['[data-look="neo"]'],
  },
  {
    name: "sequence",
    source: "sequenceDiagram\n  Browser->>API: POST /orders\n  API-->>Browser: 201 Created",
    role: "sequence",
  },
  {
    name: "class",
    source: "classDiagram\n  class Order {\n    +place() void\n  }\n  Order --> Cart",
    role: "classDiagram",
  },
  {
    name: "state",
    source: "stateDiagram-v2\n  [*] --> Pending\n  Pending --> Paid\n  Paid --> [*]",
    role: "stateDiagram",
  },
  { name: "er", source: "erDiagram\n  CUSTOMER ||--o{ ORDER : places", role: "er" },
  {
    name: "gantt",
    source:
      "gantt\n  dateFormat YYYY-MM-DD\n  section Release\n  Build :a1, 2026-01-05, 3d\n  Ship :after a1, 2d",
    role: "gantt",
  },
  { name: "mindmap", source: MINDMAP, role: "mindmap" },
  {
    name: "neo-look",
    source: `---\nconfig:\n  look: neo\n---\nflowchart LR\n  ${LOOP}`,
    role: "flowchart-v2",
    has: ['[data-look="neo"]'],
  },
  {
    name: "elk-layout",
    source: `---\nconfig:\n  layout: elk\n---\nflowchart LR\n  ${LOOP}`,
    role: "flowchart-v2",
  },
  { name: "elk-keyword", source: `flowchart-elk LR\n  ${LOOP}`, role: "flowchart-elk" },
  {
    name: "per-type-appearance",
    source: `---\nconfig:\n  flowchart:\n    look: neo\n    layout: elk\n---\nflowchart LR\n  ${LOOP}`,
    role: "flowchart-v2",
    has: ['[data-look="neo"]'],
  },
  {
    name: "elk-box",
    source: "---\nconfig:\n  layout: elk.box\n---\nflowchart LR\n  A --> B\n  C --> D\n  E --> F",
    role: "flowchart-v2",
  },
  {
    name: "elk-stress",
    source:
      "---\nconfig:\n  layout: elk.stress\n---\nflowchart LR\n  A --> B\n  B --> C\n  C --> A",
    role: "flowchart-v2",
  },
  {
    name: "redux-theme",
    source: "---\nconfig:\n  theme: redux-color\n---\nflowchart LR\n  A --> B --> C",
    role: "flowchart-v2",
  },
  {
    name: "redux-dark-theme",
    source: "---\nconfig:\n  theme: redux-dark-color\n---\nflowchart LR\n  A --> B --> C",
    role: "flowchart-v2",
  },
  {
    name: "use-case",
    source:
      'usecase-beta\ndirection LR\nactor Customer\nactor Support\nsystemBoundary Storefront\n  Browse("Browse catalogue")\n  Checkout("Checkout")\nend\nCustomer --> Browse\nCustomer --> Checkout\nSupport --> Checkout\nCheckout ..> : include Browse',
    role: "usecase",
  },
  {
    name: "agentflow",
    source:
      'agentflow-beta TB\n  flow reviewer["Review Agent"]\n    changes["Gather changes"]@{ shape: input }\n    analyse["Analyse diff"]@{ shape: task }\n    lint["run_linter"]@{ shape: tool }\n    ok["Clean?"]@{ shape: decision }\n    changes --> analyse --> lint --> ok\n  end',
    role: "agentflow",
  },
  {
    name: "bpmn",
    source:
      'flowchart LR\n  S@{ shape: bpmn-start, label: "Order received" }\n  T@{ shape: bpmn-activity, label: "Check stock" }\n  G@{ shape: bpmn-gateway, label: "In stock?" }\n  D@{ shape: bpmn-data-store, label: "Inventory" }\n  E@{ shape: bpmn-end, label: "Shipped" }\n  S --> T --> G -->|yes| E\n  T --- D',
    role: "flowchart-v2",
  },
  {
    name: "swimlanes",
    source:
      "swimlane-beta LR\n  subgraph Customer\n    Browse[Browse catalogue]\n    Pay[Pay]\n  end\n  subgraph Warehouse\n    Pick[Pick items]\n    Ship[Ship order]\n  end\n  Browse --> Pay\n  Pay --> Pick\n  Pick --> Ship",
    role: "swimlane",
  },
  {
    name: "step-animation",
    source: STEPS,
    role: "flowchart-v2",
    has: ["animateMotion", ".edge-step-dot"],
  },
  {
    name: "step-numbers",
    source: `---\nconfig:\n  flowchart:\n    stepNumbers: true\n---\n${STEPS}`,
    role: "flowchart-v2",
    has: ["animateMotion", ".edge-step-badge"],
  },
  {
    name: "mindmap-depth",
    source: `---\nconfig:\n  mindmap:\n    colorBy: depth\n---\n${MINDMAP}`,
    role: "mindmap",
  },
  {
    name: "packet-descending",
    source:
      '---\nconfig:\n  packet:\n    bitOrder: descending\n---\npacket\n  0-7: "Flags"\n  8-15: "Length"\n  16-31: "Checksum"',
    role: "packet",
  },
  // The same diagram again: its preview is a cached render, reissued under fresh ids.
  { name: "step-animation-copy", source: STEPS, role: "flowchart-v2", has: ["animateMotion"] },
];

const THEMES = ["light", "dark"] as const;
/** An empty Excalidraw drawing, for Excalidraw's own mermaid import. */
const DRAWING = "drawing.excalidraw";
const shotsDir = process.env.MERMAID_SHOTS;

/**
 * In Playwright's output dir, which it empties at the start of a run, so the repo lasts the whole
 * run: a worker restarted after a failure runs `beforeAll` again and reuses it.
 */
const repo = join(import.meta.dirname, "../test-results/mermaid-fixture");

test.beforeAll(async ({ request }) => {
  if (shotsDir) mkdirSync(shotsDir, { recursive: true });
  if (existsSync(join(repo, ".git"))) return;
  mkdirSync(repo, { recursive: true });
  const body = DIAGRAMS.map((d) => `## ${d.name}\n\n\`\`\`mermaid\n${d.source}\n\`\`\`\n`).join(
    "\n",
  );
  writeFileSync(join(repo, "diagrams.md"), `# Diagrams\n\n${body}`);
  writeFileSync(
    join(repo, DRAWING),
    JSON.stringify({ type: "excalidraw", version: 2, elements: [] }),
  );
  // A project shows in the sidebar once its repo has a commit.
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git(
    "-c",
    "commit.gpgsign=false",
    "-c",
    "user.name=e2e",
    "-c",
    "user.email=e2e@example.com",
    "commit",
    "-q",
    "-m",
    "diagrams",
  );
  const res = await request.post("/api/projects", { data: { path: repo, name: "mermaid-e2e" } });
  expect(res.ok()).toBe(true);
});

/** Serve this page the given theme setting and keep its settings writes off the shared server. */
async function useTheme(page: Page, theme: (typeof THEMES)[number]): Promise<void> {
  await page.route("**/api/stores/settings", async (route) => {
    if (route.request().method() !== "GET") return route.fulfill({ json: { success: true } });
    const res = await route.fetch();
    const { value } = (await res.json()) as { value: string | null };
    const stored = value ? (JSON.parse(value) as { state: object; version: number }) : null;
    const next = JSON.stringify({
      version: stored?.version ?? useSettingsStore.persist.getOptions().version,
      state: { ...stored?.state, theme },
    });
    return route.fulfill({ json: { value: next } });
  });
}

/** Load Loxel and open a fixture file the way `loxel <file>` does. */
async function openFile(page: Page, file: string): Promise<void> {
  await waitForLoxel(page);
  const windowId = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.endsWith("-window-id"));
    return key ? (localStorage.getItem(key) ?? "") : "";
  });
  const res = await page.request.post("/api/open", {
    data: { filePath: join(repo, file), windowId },
  });
  expect(res.ok()).toBe(true);
}

async function openDiagrams(page: Page): Promise<Locator> {
  await openFile(page, "diagrams.md");
  const editor = page.locator(".milkdown:visible").first();
  await expect(editor.locator(".milkdown-code-block")).toHaveCount(DIAGRAMS.length);
  return editor;
}

/** Node positions of a flowchart's light variant, to tell one layout from another. */
function nodePositions(block: Locator): Promise<string> {
  return block
    .locator(".loxel-mermaid-light g.node")
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("transform")).join(" "));
}

for (const theme of THEMES) {
  test(`renders every diagram type (${theme})`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await useTheme(page, theme);
    // Mermaid's styles, SMIL animations and ELK all run under the renderer's CSP.
    const refused: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error" && /Content Security Policy|Refused to/i.test(msg.text())) {
        refused.push(msg.text());
      }
    });
    const editor = await openDiagrams(page);
    const blocks = editor.locator(".milkdown-code-block");
    const positions = new Map<string, string>();
    /** Each SVG's ids, read while its block is on screen (Crepe unmounts off-screen blocks). */
    const svgIds: string[][] = [];

    for (const [index, diagram] of DIAGRAMS.entries()) {
      const block = blocks.nth(index);
      // Code blocks off-screen render nothing, so bring each one into view.
      await block.scrollIntoViewIfNeeded();
      const preview = block.locator(".loxel-mermaid, .loxel-mermaid-error-preview").first();
      await expect(preview, diagram.name).toBeVisible({ timeout: 30_000 });
      await expect(block.locator(".loxel-mermaid-error"), diagram.name).toHaveCount(0);

      for (const variant of ["light", "dark"]) {
        const svg = block.locator(`.loxel-mermaid-${variant} > svg`);
        await expect(svg, `${diagram.name} ${variant}`).toHaveAttribute(
          "aria-roledescription",
          diagram.role,
        );
        await expect(svg, `${diagram.name} ${variant}`).toHaveAttribute("viewBox", /\S+ \S+ \d/);
      }
      await expect(block.locator(`.loxel-mermaid-${theme} > svg`)).toBeVisible();
      for (const selector of diagram.has ?? []) {
        await expect(
          block.locator(`.loxel-mermaid-light ${selector}`).first(),
          `${diagram.name} has ${selector}`,
        ).toBeAttached();
      }
      for (const selector of diagram.hasNot ?? []) {
        await expect(
          block.locator(`.loxel-mermaid-light ${selector}`),
          `${diagram.name} has no ${selector}`,
        ).toHaveCount(0);
      }
      svgIds.push(
        ...(await block
          .locator(".loxel-mermaid svg[aria-roledescription]")
          .evaluateAll((svgs) =>
            svgs.map((svg) => [svg.id, ...[...svg.querySelectorAll("[id]")].map((el) => el.id)]),
          )),
      );
      if (diagram.role.startsWith("flowchart"))
        positions.set(diagram.name, await nodePositions(block));
      if (shotsDir) {
        await block.locator(".loxel-mermaid").hover();
        await block.screenshot({ path: join(shotsDir, `${diagram.name}-${theme}.png`) });
      }
    }

    // The default stays on dagre; `layout: elk` and the `flowchart-elk` keyword both get ELK.
    expect(positions.get("elk-layout")).not.toBe(positions.get("flowchart"));
    expect(positions.get("elk-keyword")).toBe(positions.get("elk-layout"));

    // Two previews of one diagram (and the variants of each) never share an element id, step
    // animation ids included, so each animation's `begin` references resolve within its own copy.
    // (Mermaid repeats some ids within one SVG, so only ids across SVGs count.)
    const owners = new Map<string, number>();
    for (const ids of svgIds)
      for (const id of new Set(ids)) owners.set(id, (owners.get(id) ?? 0) + 1);
    const shared = [...owners].filter(([, count]) => count > 1).map(([id]) => id);
    expect(shared).toEqual([]);
    expect(refused).toEqual([]);
  });
}

test("opens a step-animated diagram full size with its animation", async ({ page }) => {
  await useTheme(page, "light");
  const editor = await openDiagrams(page);
  const block = editor
    .locator(".milkdown-code-block")
    .nth(DIAGRAMS.findIndex((d) => d.name === "step-numbers"));
  await block.scrollIntoViewIfNeeded();
  const diagram = block.locator(".loxel-mermaid");
  const svg = diagram.locator(".loxel-mermaid-light > svg");
  await expect(svg).toBeVisible({ timeout: 30_000 });
  await svg.click(); // a click that does not drag opens the viewer
  const viewer = page.locator("dialog[open]");
  await expect(viewer.locator("svg[aria-roledescription] animateMotion").first()).toBeAttached();
  await expect(viewer.locator("svg[aria-roledescription] .edge-step-badge").first()).toBeAttached();
  // The viewer's copy shares no id with the preview's, as above.
  const shared = await page.evaluate(() => {
    const svgOf = (el: Element) => el.closest("svg[aria-roledescription]");
    return [...document.querySelectorAll("dialog[open] svg[aria-roledescription] [id]")]
      .filter((el) =>
        [...document.querySelectorAll(`[id="${CSS.escape(el.id)}"]`)].some(
          (other) => svgOf(other) !== svgOf(el),
        ),
      )
      .map((el) => el.id);
  });
  expect(shared).toEqual([]);
});

/**
 * Excalidraw turns pasted mermaid text into shapes through @excalidraw/mermaid-to-excalidraw, which
 * the workspace overrides to 3.x (no mermaid of its own) under @excalidraw/excalidraw.
 */
test("Excalidraw imports pasted mermaid text", async ({ page }) => {
  await openFile(page, DRAWING);
  const canvas = page.locator(".excalidraw:visible canvas.interactive").first();
  await expect(canvas).toBeVisible();
  // Excalidraw takes a paste only with focus in its container and the pointer over its canvas.
  await canvas.hover({ position: { x: 300, y: 300 } });
  await page.locator(".excalidraw-container:visible").first().focus();
  await page.evaluate((text) => {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
  }, "flowchart LR\n  Cart[Shopping cart] --> Checkout[Checkout]");
  await page.keyboard.press("Meta+s");
  await expect
    .poll(
      async () => {
        const saved = (await Bun.file(join(repo, DRAWING)).json()) as {
          elements: { type: string; text?: string }[];
        };
        return saved.elements
          .filter((e) => e.type === "text")
          .map((e) => e.text ?? "")
          .sort((a, b) => a.localeCompare(b));
      },
      { timeout: 15_000 },
    )
    .toEqual(["Checkout", "Shopping cart"]);
});
