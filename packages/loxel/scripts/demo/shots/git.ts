import type { Page } from "@playwright/test";

import {
  clearLogsDot,
  collapseSidebar,
  diffLine,
  dragDivider,
  openBranchChanges,
  row,
  type Shot,
  until,
} from "../shot-kit";

/** The first commit the graph shows: main's release after #1107, above the task's branch. */
const GRAPH_TOP = "5f4fe23";
/** The branch side's lines the diff shows: the toast's hover and focus handlers. */
const DIFF_TOP = 83;
const DIFF_LINES = 21;
/** The diff's line height (EditorPanel's Monaco option). */
const LINE_HEIGHT = 22;

/** How far the branch side's line `line` sits below the top of the split diff's code area. */
async function diffLineOffset(page: Page, line: number): Promise<number | null> {
  const at = await diffLine(page, line);
  return at && at.cell.y - at.areaTop;
}

/** Scroll the split diff until the branch side's line `line` is the first one shown. */
async function scrollDiffTo(page: Page, line: number, at: { x: number; y: number }): Promise<void> {
  await until(
    async () => Math.abs((await diffLineOffset(page, line)) ?? 999) < 2,
    async () => {
      await page.mouse.move(at.x, at.y);
      await page.mouse.wheel(0, (await diffLineOffset(page, line)) ?? 400);
      await page.waitForTimeout(200);
    },
    `scroll the diff to line ${line}`,
  );
}

/** Widen the graph's lane and label column by `by` pixels, so each commit's labels fit. */
async function widenGraphColumn(page: Page, by: number): Promise<void> {
  const handle = await page.evaluate(() => {
    const r = [...document.querySelectorAll(".cursor-col-resize")]
      .map((h) => h.getBoundingClientRect())
      .filter((rect) => rect.height > 100)
      .toSorted((a, b) => a.x - b.x)[0];
    return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
  });
  if (!handle) throw new Error("No graph column handle");
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  await page.mouse.move(handle.x + by, handle.y, { steps: 8 });
  await page.mouse.up();
}

/**
 * Show the commit `hash` as the graph's first row, and keep it there until the shot is captured:
 * the graph's list goes back to its top whenever another tool zone opens or closes (the runner
 * toggles Logs before capturing). The list's overlay scrollbar is hidden, as it would have faded
 * by then.
 */
async function pinGraphAt(s: Shot, hash: string): Promise<void> {
  const { page } = s;
  const commit = page.getByText(hash, { exact: true });
  await until(
    () => commit.isVisible(),
    // More history loads as the list nears its end.
    () =>
      page.evaluate(() => {
        const any = [...document.querySelectorAll("span, div")].find(
          (e) => e.childElementCount === 0 && /^[0-9a-f]{7}$/.test(e.textContent?.trim() ?? ""),
        );
        const list = any?.closest(".overflow-auto");
        if (list) list.scrollTop = list.scrollHeight;
      }),
    `find commit ${hash}`,
  );
  const timer = await page.evaluate((h) => {
    const pin = () => {
      const cell = [...document.querySelectorAll("span, div")].find(
        (e) => e.childElementCount === 0 && e.textContent?.trim() === h,
      );
      const list = cell?.closest<HTMLElement>(".overflow-auto");
      const commitRow = cell?.parentElement?.closest("[style*=top]") ?? cell;
      if (!list || !commitRow) return;
      list.style.scrollbarWidth = "none";
      const off = commitRow.getBoundingClientRect().top - list.getBoundingClientRect().top;
      if (Math.abs(off) > 1) list.scrollTop += off;
    };
    pin();
    return window.setInterval(pin, 30);
  }, hash);
  s.cleanups.push(() => page.evaluate((id) => window.clearInterval(id), timer));
  await until(
    () =>
      page.evaluate((h) => {
        const cell = [...document.querySelectorAll("span, div")].find(
          (e) => e.childElementCount === 0 && e.textContent?.trim() === h,
        );
        const list = cell?.closest(".overflow-auto");
        return !!list && list.scrollTop > 0;
      }, hash),
    async () => {},
    `scroll the graph to ${hash}`,
  );
}

/** Shot 5 in shots.md: what's landing, the history under the PR's diff. */
export default async function git(s: Shot): Promise<void> {
  const { page } = s;
  await row(page, "Worktree error toast").click();
  await collapseSidebar(page);

  const search = page.getByPlaceholder("Search commits...");
  await until(
    () => search.isVisible(),
    () => page.keyboard.press("Control+Shift+G"),
    "open Git",
  );

  // The PR's files, and toast.tsx's split diff above the Git panel.
  const changes = await openBranchChanges(page);
  await page.getByText("toast.tsx", { exact: true }).dblclick();
  await page.getByText("Loading file content...").waitFor({ state: "hidden", timeout: 30_000 });

  // Proportions: Git ~45% of the window's height, the diff above it ending on a whole line
  // (lines 83 to 103, `};` down to the last handler's `}}`); Changes wide enough for the PR's
  // file names.
  const changesBox = await changes.locator("..").boundingBox();
  const codeTop = await page.evaluate(() => {
    const cell = [...document.querySelectorAll("div.font-mono.select-none")].find(
      (d) => d.getBoundingClientRect().height > 0,
    );
    return cell?.closest(".overflow-hidden")?.getBoundingClientRect().top;
  });
  const searchBox = await search.boundingBox();
  if (!changesBox || codeTop === undefined || !searchBox) throw new Error("No layout to size");
  await dragDivider(
    page,
    { x: changesBox.x + 600, y: searchBox.y - 8 },
    "y",
    codeTop + DIFF_LINES * LINE_HEIGHT + 2,
  );
  const changesRight = changesBox.x + changesBox.width;
  await dragDivider(page, { x: changesRight, y: changesBox.y + 100 }, "x", changesRight + 100);

  const code = await page.getByText("Working Tree", { exact: true }).boundingBox();
  if (!code) throw new Error("No split diff");
  await scrollDiffTo(page, DIFF_TOP, { x: code.x + 100, y: code.y + 120 });
  await widenGraphColumn(page, 75);
  await pinGraphAt(s, GRAPH_TOP);

  // Clear a Logs dot here: Logs shares the bottom zone, so toggling it closes Git, and Git is
  // put back right after.
  if (await clearLogsDot(page)) {
    await until(
      () => search.isVisible(),
      () => page.keyboard.press("Control+Shift+G"),
      "reopen Git",
    );
  }
}
