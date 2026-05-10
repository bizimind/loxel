import type { Page } from "@playwright/test";

import { resolve } from "node:path";

const SCREENSHOTS_DIR = resolve(import.meta.dirname, "../../../site/public/screenshots");

/**
 * Capture a screenshot of the current page.
 *
 * Saves two files:
 *   - `<name>.png`            — full-page screenshot
 *   - `<name>-viewport.png`   — viewport-clipped crop (1440×900)
 *
 * Both are written to `packages/site/public/screenshots/`.
 */
export async function captureScreenshot(page: Page, name: string): Promise<void> {
  const fullPath = resolve(SCREENSHOTS_DIR, `${name}.png`);
  const viewportPath = resolve(SCREENSHOTS_DIR, `${name}-viewport.png`);

  await page.screenshot({ path: fullPath, fullPage: true });

  await page.screenshot({ path: viewportPath, clip: { x: 0, y: 0, width: 1440, height: 900 } });
}
