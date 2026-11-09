import { homedir } from "node:os";

import type { Locator } from "@playwright/test";

import {
  collapseSidebar,
  dragDivider,
  group,
  parkMouse,
  row,
  scrollEditorTo,
  type Shot,
} from "../shot-kit";

const FILE = "packages/loxel/src/cli.ts";
const TAB = "cli.ts";
/**
 * cli.ts on main: the second half of `main()`, down to its closing brace (148) and the blank line
 * after it, which the bottom edge cuts. The hover card goes on the `launchLoxel` call on line 114:
 * above it, it covers only the port lookup, and it ends left of the right third.
 */
const TOP_LINE = 99;
const HOVERED = "launchLoxel";

/** The tree's state: the names cut short in view, and its right edge. */
const treeState = (cli: Locator) =>
  cli.evaluate((el) => {
    let box = el.parentElement;
    while (box && !/(auto|scroll)/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
    if (!box) throw new Error("The tree row has no scroll container");
    const view = box.getBoundingClientRect();
    const cut = [
      ...box.querySelectorAll<HTMLElement>("button[data-tree-name] span.truncate"),
    ].filter((e) => {
      const r = e.getBoundingClientRect();
      return r.bottom > view.top && r.top < view.bottom && e.scrollWidth > e.clientWidth;
    });
    return {
      cut: cut.map((e) => e.textContent),
      short: Math.max(0, ...cut.map((e) => e.scrollWidth - e.clientWidth)),
      right: view.right,
    };
  });

/** Shot 6 in shots.md: the code at a glance, with a hover card on a real call. */
export default async function editor(s: Shot): Promise<void> {
  const { page } = s;
  await row(page, "main").click();
  await s.loxel("loxel", "main", "--focus", FILE);
  await page.locator(".monaco-editor .view-line").first().waitFor();
  await page.keyboard.press("Meta+Shift+E");
  await page.getByTitle("Reveal active editor in tree").click();
  const cli = page.locator('button[data-tree-name="cli.ts"][data-tree-selected]');
  await cli.waitFor();
  await collapseSidebar(page);

  // The tree just wide enough for every name in view.
  for (let attempt = 0; ; attempt++) {
    const { cut, short, right } = await treeState(cli);
    if (!cut.length) break;
    if (attempt === 5) throw new Error(`Tree names cut off: ${cut.join(", ")}`);
    const row = await cli.boundingBox();
    if (!row) throw new Error("The tree row isn't rendered");
    await dragDivider(page, { x: right + 2, y: row.y }, "x", right + short + 8);
  }
  // The path above the tree shows the home folder as "~", so the user's name never appears.
  if (await page.getByText(homedir(), { exact: false }).count())
    throw new Error("The home folder's path shows on screen");

  await scrollEditorTo(page, TAB, TOP_LINE);
  const editor = group(page, TAB).locator(".monaco-editor").first();
  const overflow = await editor.evaluate((el) => {
    const guard = el.querySelector(".overflow-guard")?.getBoundingClientRect();
    if (!guard) throw new Error("The editor isn't rendered");
    const right = Math.max(
      ...[...el.querySelectorAll(".view-line > span")].map((e) => e.getBoundingClientRect().right),
    );
    return right - (guard.right - 14); // the vertical scrollbar's width
  });
  if (overflow > 0) throw new Error(`A code line runs ${overflow}px past the editor's edge`);

  // The hover card, from the keyboard (Cmd+K Cmd+I), so the parked mouse can't dismiss it.
  const word = await editor.evaluate((el, name) => {
    const span = [...el.querySelectorAll(".view-line span span")].find(
      (e) => e.textContent === name,
    );
    if (!span) return null;
    const { x, y, height } = span.getBoundingClientRect();
    return { x, y, height };
  }, HOVERED);
  if (!word) throw new Error(`${HOVERED} isn't on screen`);
  await page.mouse.click(word.x + 1, word.y + word.height / 2);
  // Leave the editor's last pointer position on blank space, so Cmd makes no word a link.
  await page.mouse.move(word.x + 1, word.y + 3 * 22 + word.height / 2);
  await parkMouse(page);
  await page.keyboard.press("Meta+K");
  await page.keyboard.press("Meta+I");
  const hover = page.locator(".monaco-hover", { hasText: `function ${HOVERED}` });
  await hover.waitFor();
  // Unfocused, the editor hides its caret and keeps the hover, as after a mouse hover.
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  const card = await hover.boundingBox();
  const width = page.viewportSize()?.width ?? 1920;
  if (!card || card.x + card.width > (width * 2) / 3)
    throw new Error(`The hover card reaches into the right third: ${JSON.stringify(card)}`);
}
