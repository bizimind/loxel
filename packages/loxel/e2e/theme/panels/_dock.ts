/**
 * Layout helpers shared by panel scripts (not a panel itself). The default left dock is ~100 px in
 * the 1600 px window, which truncates file names to nothing, so file-tree shots widen it first.
 */
import type { Page } from "@playwright/test";

/** Drag the vertical sash on the right of the left dock to `toX`. */
export async function widenLeftDock(page: Page, toX: number): Promise<void> {
  for (const sash of await page.locator(".dv-sash.dv-enabled").all()) {
    const box = await sash.boundingBox();
    if (!box || box.width > 10 || box.x > 400) continue;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(toX, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    return;
  }
  throw new Error("left dock sash not found");
}
