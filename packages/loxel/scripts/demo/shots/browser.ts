import type { Page } from "@playwright/test";

import { HANDLES_DRAWING as DRAWING, HANDLES_LAYOUT, handlesDrawing } from "../demo-projects";
import { dragDivider, groupRect, row, type Shot, until } from "../shot-kit";

const PR = "https://github.com/excalidraw/excalidraw/pull/11006";
/** The PR's tab, titled by GitHub once the page loads. */
const PR_TAB = /^\s*fix\(packages\/excalidraw\)/;

/** The Electron `<webview>` element's methods this shot uses. */
interface Webview {
  isLoading(): boolean;
  getWebContentsId(): number;
  executeJavaScript(code: string): Promise<unknown>;
}

/** The PR's browser panel: the webview on screen (other tasks' stay mounted, hidden). */
const prView = (page: Page) => page.locator("webview").filter({ visible: true });

/** Run `script` in the browser panel's page and return its result. */
const inPage = (page: Page, script: string): Promise<unknown> =>
  prView(page).evaluate(
    (el, script) => (el as unknown as Webview).executeJavaScript(script),
    script,
  );

/** The Excalidraw app's scene transform and selection (its App's state, read through React's fiber). */
const sceneState = (page: Page) =>
  page.evaluate(() => {
    const root = [...document.querySelectorAll(".excalidraw")].find(
      (e) => e.getBoundingClientRect().width > 0,
    );
    if (!root) throw new Error("No drawing on screen");
    const key = Object.keys(root).find((k) => k.startsWith("__reactFiber$"));
    type Fiber = { return: Fiber | null; stateNode: unknown };
    let fiber = key ? (root as unknown as Record<string, Fiber>)[key] : null;
    for (; fiber; fiber = fiber.return) {
      const state = (fiber.stateNode as { state?: Record<string, unknown> } | null)?.state;
      if (!state || !("scrollX" in state && "zoom" in state)) continue;
      const num = (value: unknown) => {
        if (typeof value !== "number") throw new Error("Excalidraw's state has changed shape");
        return value;
      };
      const { zoom, selectedElementIds } = state;
      return {
        scrollX: num(state.scrollX),
        scrollY: num(state.scrollY),
        zoom: num(typeof zoom === "object" && zoom !== null && "value" in zoom ? zoom.value : null),
        offsetLeft: num(state.offsetLeft),
        offsetTop: num(state.offsetTop),
        selected: Object.keys(
          typeof selectedElementIds === "object" ? (selectedElementIds ?? {}) : {},
        ),
      };
    }
    throw new Error("No Excalidraw app state");
  });

/** The boxes of the PR's group and of the drawing's. */
const groups = async (page: Page) => ({
  pr: await groupRect(page, PR_TAB),
  drawing: await groupRect(page, DRAWING),
});

/** Shot 4 in shots.md: the PR on GitHub beside the drawing that shows what it fixes. */
export default async function browser(s: Shot): Promise<void> {
  const { page } = s;
  await Bun.write(`${s.worktree("excalidraw", "selection-color")}/${DRAWING}`, handlesDrawing());
  await row(page, "Selection color handles").click();
  await s.loxel("excalidraw", "selection-color", "--focus", PR);
  const view = await prView(page).elementHandle({ timeout: 60_000 });
  await page.waitForFunction(
    async (el) => {
      const webview = el as unknown as Webview;
      if (webview.isLoading()) return false;
      try {
        return (await webview.executeJavaScript("document.readyState")) === "complete";
      } catch {
        return false;
      }
    },
    view,
    { timeout: 60_000 },
  );
  // GitHub signed out follows the system's color scheme: dark, like the rest of the window.
  const guest = await view.evaluate((el) => (el as unknown as Webview).getWebContentsId());
  await s.app.evaluate(async ({ webContents }, id) => {
    const contents = webContents.fromId(id);
    if (!contents) throw new Error("No browser page");
    if (!contents.debugger.isAttached()) contents.debugger.attach();
    await contents.debugger.sendCommand("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: "dark" }],
    });
  }, guest);
  if ((await inPage(page, "matchMedia('(prefers-color-scheme: dark)').matches")) !== true)
    throw new Error("GitHub isn't dark");

  await s.loxel("excalidraw", "selection-color", "--split", "right", "--focus", DRAWING);
  await page.locator(".excalidraw").waitFor();
  await s.loxel(
    "excalidraw",
    "selection-color",
    "--group",
    DRAWING,
    "--no-focus",
    "packages/excalidraw/renderer/interactiveScene.ts",
  );

  // Proportions: the PR ~55% of the width, the drawing ~45%.
  const start = await groups(page);
  const left = start.pr.x;
  const width = start.drawing.x + start.drawing.width - left;
  const prRight = async () => {
    const { pr } = await groups(page);
    return pr.x + pr.width;
  };
  await until(
    async () => Math.abs((await prRight()) - (left + width * 0.55)) < 4,
    async () => {
      const { pr } = await groups(page);
      await dragDivider(
        page,
        { x: await prRight(), y: pr.y + pr.height / 2 },
        "x",
        left + width * 0.55,
      );
    },
    "size the PR's pane",
  );

  // The PR from its title: the title, its branches, the tabs and the description.
  await inPage(
    page,
    `(() => {
      const title = [...document.querySelectorAll("h1")].find((h) => h.textContent.includes("point handles"));
      window.scrollTo(0, title.getBoundingClientRect().top + scrollY - 16);
    })()`,
  );

  // The whole drawing in view (Shift+1), then the arrow selected, so its point handles show.
  const { drawing } = await groups(page);
  await page.mouse.click(drawing.x + 24, drawing.y + drawing.height - 120);
  const before = await sceneState(page);
  await page.keyboard.press("Shift+1");
  await until(
    async () => {
      const now = await sceneState(page);
      return (
        now.scrollX !== before.scrollX || now.scrollY !== before.scrollY || now.zoom !== before.zoom
      );
    },
    async () => {},
    "fit the drawing in view",
  );
  const t = await sceneState(page);
  const at = (x: number, y: number) => ({
    x: (x + t.scrollX) * t.zoom + t.offsetLeft,
    y: (y + t.scrollY) * t.zoom + t.offsetTop,
  });
  // The arrow's middle point, on its curve.
  const { boxWidth, boxHeight, gap, bulge } = HANDLES_LAYOUT;
  const apex = at(boxWidth / 2 - bulge, boxHeight + gap / 2);
  await until(
    async () => (await sceneState(page)).selected.join() === "fix",
    () => page.mouse.click(apex.x, apex.y),
    "select the arrow",
  );
}
