import type { Page } from "@playwright/test";

import {
  collapseSidebar,
  diffLine,
  dragDivider,
  groupOf,
  openBranchChanges,
  type Rect,
  row,
  type Shot,
  until,
} from "../shot-kit";

/** Review threads on the PR, by file and line on the branch's side. */
const THREADS = [
  {
    // webviewRef.current?.reloadIgnoringCache();
    file: "BrowserPanel.tsx",
    line: 330,
    body: "Hard refresh: because sometimes the cache needs to hear it twice. Should it skip the service worker too?",
  },
  {
    // return registerHardRefreshTarget(root, hardRefresh);
    file: "BrowserPanel.tsx",
    line: 336,
    body: "Cmd+Shift+R is Rename Tab everywhere else. Is focus inside this panel enough to keep them apart?",
  },
  {
    // "browser.hardRefresh": ["Cmd+Shift+R"],
    file: "keybinding-schema.ts",
    line: 103,
    body: "Remapping Rename Tab leaves hard refresh alone on Cmd+Shift+R. Is that what we want, or should the two move together?",
  },
] as const;

/** The box of the side panel (a dockview group) headed `heading`. */
async function sidePanelRect(page: Page, heading: RegExp): Promise<Rect> {
  const panel = groupOf(page.locator("h2").filter({ visible: true, hasText: heading }));
  const box = await panel.boundingBox();
  if (!box) throw new Error(`No side panel headed ${heading}`);
  return box;
}

/** Shot 2 in shots.md: the PR under review, with comment threads beside the diff. */
export default async function worktreesReview(s: Shot): Promise<void> {
  const { page } = s;
  await row(page, "Hard-refresh tabs").click();
  await collapseSidebar(page);

  // Changes, switched to the whole branch, and the PR's browser panel change in a split diff.
  await openBranchChanges(page);
  await page.getByText("BrowserPanel.tsx", { exact: true }).dblclick();
  await page.getByRole("button", { name: "Split", exact: true }).click();

  // A review for the PR in Comments.
  const comments = page.locator("h2", { hasText: /^Comments/ });
  await until(
    () => comments.isVisible(),
    () => page.keyboard.press("Control+Shift+R"),
    "open Comments",
  );
  await comments.locator("..").getByRole("button", { name: "Reviews" }).click();
  await page.getByTitle("New review").click();
  const name = page.getByPlaceholder("Review name...");
  await name.fill("PR #1052");
  await name.press("Enter");
  await page.keyboard.press("Escape");

  // Proportions: Changes ~20% of the width (its file names whole), the diff ~59%,
  // Comments ~21%.
  const changesGroup = () => sidePanelRect(page, /^Changes/);
  const [first, last] = [await changesGroup(), await sidePanelRect(page, /^Comments/)];
  const width = last.x + last.width - first.x;
  const mid = first.y + first.height / 2;
  await dragDivider(page, { x: last.x, y: mid }, "x", first.x + width * 0.79);
  const changesNow = await changesGroup();
  await dragDivider(
    page,
    { x: changesNow.x + changesNow.width, y: mid },
    "x",
    first.x + width * 0.2,
  );

  for (const [i, thread] of THREADS.entries()) {
    const previous = THREADS[i - 1];
    if (previous && previous.file !== thread.file)
      await page.getByText(thread.file, { exact: true }).dblclick();
    await page.getByText("Loading file content...").waitFor({ state: "hidden" });
    const at = await diffLine(page, thread.line);
    if (!at) throw new Error(`No line ${thread.line} in the diff`);
    await page.mouse.click(at.cell.x + at.cell.width / 2, at.cell.y + at.cell.height / 2);
    const box = page.getByPlaceholder("Write a comment...");
    await box.fill(thread.body);
    await box.press("Meta+Enter");
    await page.locator("h2", { hasText: `Comments (${i + 1})` }).waitFor();
  }
  // Back to BrowserPanel.tsx. The last commented line stays selected, with its Add comment
  // button; a remount clears it.
  await page.getByText("BrowserPanel.tsx", { exact: true }).dblclick();
  await page.getByRole("button", { name: "Unified", exact: true }).click();
  await page.getByRole("button", { name: "Split", exact: true }).click();

  await s.loxel(
    "loxel",
    "hard-refresh",
    "--no-focus",
    "https://github.com/bizimind/loxel/pull/1052",
  );
  // Loaded: titled, with GitHub's icon. Its page load logs the odd warning (long tasks), which
  // would land after the runner clears the Logs dot; let it settle first.
  await page
    .locator(".dv-tab", { hasText: "Cmd+Shift" })
    .locator("img")
    .waitFor({ timeout: 30_000 });
  await page.waitForTimeout(3000);
  // The hard-reload thread open in Comments, the other one listed below it.
  await page.getByText(THREADS[0].body.slice(0, 20)).first().click();
  await page.getByPlaceholder("Reply...").waitFor();
}
