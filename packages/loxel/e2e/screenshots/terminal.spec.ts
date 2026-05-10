import { test } from "@playwright/test";

import { captureScreenshot } from "../helpers/screenshot";
import { waitForLoxel } from "../helpers/server";

const DEMO_PROJECT_PATH = `${process.env.HOME}/.loxel-demo/my-project`;

test("terminal screenshot", async ({ page, request }) => {
  // Register the demo project so the app has a project context.
  await request.post("/api/projects", { data: { path: DEMO_PROJECT_PATH, name: "my-project" } });

  await waitForLoxel(page);

  // Open the first terminal by dispatching the create event.
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("loxel-create-terminal"));
  });

  // Wait for xterm.js to mount — it appends a canvas inside the container div.
  await page.locator(".xterm-screen").first().waitFor({ state: "visible" });

  // Give the PTY a moment to connect before typing.
  await page.waitForTimeout(800);

  // Type a git log command in the first terminal.
  await page.keyboard.type("git log --oneline");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1200);

  // Open a second terminal tab.
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("loxel-create-terminal"));
  });
  // When a new terminal tab opens, dockview hides the previous tab's xterm-screen.
  // Wait for any visible xterm-screen to be present (the newly active one).
  await page
    .locator(".xterm-screen:visible")
    .first()
    .waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForTimeout(800);

  // Simulate test output in the second terminal.
  await page.keyboard.type('echo "✓ 12 tests passed"');
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);

  // Open a third terminal tab — leave it at the prompt.
  // TODO: find a reliable selector for the tab bar "New Terminal" button so we
  // can click it instead of dispatching the event directly.
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("loxel-create-terminal"));
  });
  await page
    .locator(".xterm-screen:visible")
    .first()
    .waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForTimeout(500);

  await captureScreenshot(page, "terminal");
});
