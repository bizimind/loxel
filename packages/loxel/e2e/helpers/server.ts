import type { Page } from "@playwright/test";

/**
 * Navigate to the app and wait for it to be fully loaded and hydrated.
 * Screenshot mode (fake traffic lights, no DEV badge) is baked in at build time via VITE_SCREENSHOT=1.
 *
 * If the app shows the "No project open" empty state (because no worktree is
 * persisted as active), clicks the first project icon in the sidebar to
 * activate it and waits for the main layout (LeftToolsBar) to appear.
 *
 * After this function resolves, the center dockview is mounted and the
 * `centerApi` is ready for panel creation events.
 */
export async function waitForLoxel(page: Page): Promise<void> {
  await page.goto("/");

  // The TopBar always renders the "Loxel" brand text — wait for it to appear.
  await page.getByText("Loxel").first().waitFor({ state: "visible" });

  // Wait for React hydration to settle (no in-flight network requests).
  await page.waitForLoadState("networkidle");

  // If the toolbar icons (Git, Comments, etc.) are already visible the app is
  // ready with an active worktree — nothing more to do.
  const gitButton = page.locator('[title="Git"]').first();
  const isReady = await gitButton.isVisible();
  if (!isReady) {
    // Otherwise the app is showing the "No project open" empty state. The sidebar
    // shows project icons as <button> elements whose `title` attribute is
    // `"<name>\n<path>"` (collapsed mode). The sidebar container has classes
    // `bg-card border-border flex flex-col border-r`. Scope the click to buttons
    // inside that sidebar div to avoid hitting StatusBar buttons.
    const sidebar = page.locator(".border-border.flex.flex-col.border-r").first();
    const firstProjectBtn = sidebar
      .locator(
        'button[title]:not([title="Add project"]):not([title="Collapse sidebar"]):not([title="Expand sidebar"])',
      )
      .first();
    await firstProjectBtn.waitFor({ state: "visible", timeout: 10_000 });
    await firstProjectBtn.click();

    // Wait for the LeftToolsBar (toolbar icons for Git, Comments, etc.) to appear.
    await gitButton.waitFor({ state: "visible", timeout: 15_000 });
  }

  // Wait for the center dockview's CenterWatermark to appear. This confirms
  // that CenterHost's `onApiReady` callback has fired and `centerApi` is set,
  // so panel-creation events dispatched after this will work. The watermark
  // renders a "New Terminal" button among its quickstart actions.
  await page
    .getByRole("button", { name: "New Terminal" })
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });

  // Settle any subsequent network requests.
  await page.waitForLoadState("networkidle");
}
