import { test } from "@playwright/test";

import { captureScreenshot } from "../helpers/screenshot";
import { waitForLoxel } from "../helpers/server";

const DEMO_PROJECT_PATH = `${process.env.HOME}/.loxel-demo/my-project`;

/**
 * Fork tree screenshot.
 *
 * Captures the Fork Tree sidebar panel showing the SVG branch tree after a real
 * fork. The coding agent is a local runtime with no external API dependencies —
 * no API key is required.
 *
 * Flow:
 * 1. Register the demo project and open an agent panel.
 * 2. Send a short message and wait for the agent to produce output.
 * 3. Wait for the run to complete so fork actions are enabled.
 * 4. Hover over the first timeline row to reveal the "Fork from here" button.
 * 5. Click "Fork from here" — the server emits session.forked and a new tab opens.
 * 6. Open the Fork Tree sidebar panel — branchInfo now has two branches.
 * 7. Capture the screenshot.
 */
test("fork tree screenshot", async ({ page, request }) => {
  // Register the demo project so the agent has a workspace root.
  await request.post("/api/projects", { data: { path: DEMO_PROJECT_PATH, name: "my-project" } });

  await waitForLoxel(page);

  // Open a new agent panel.
  await page.getByTitle("New Agent").click();

  // Wait for the input textarea to appear.
  const inputArea = page.locator("textarea").first();
  await inputArea.waitFor({ state: "visible", timeout: 10_000 });

  // Send a short message to start a session.
  await inputArea.fill("What files are in the src directory?");
  await inputArea.press("Enter");

  // Wait for the user message bubble (optimistic UI).
  await page.locator(".bg-card").first().waitFor({ state: "visible", timeout: 15_000 });

  // Wait for at least one timeline row to appear (agent has started responding).
  const firstRow = page.locator(".group\\/row").first();
  await firstRow.waitFor({ state: "visible", timeout: 60_000 });

  // Wait for the run to complete — the typing indicator disappears and the
  // input textarea becomes enabled again (status returns to "ready").
  // We poll for the textarea to be enabled as a proxy for run completion.
  await page.locator("textarea").first().waitFor({ state: "visible", timeout: 120_000 });
  await page.waitForFunction(
    () => {
      const ta = document.querySelector("textarea");
      return ta && !ta.disabled;
    },
    { timeout: 120_000 },
  );

  // Hover over the first timeline row to reveal gutter action buttons.
  await firstRow.hover();

  // Click "Fork from here" to create a branch.
  await page.getByTitle("Fork from here").first().click();

  // Open the Fork Tree sidebar panel.
  await page.getByTitle("Fork Tree").click();

  // Wait for the SVG branch tree to appear — it renders inside an <svg> element
  // once branchInfo has at least two branches.
  await page.locator("svg circle").first().waitFor({ state: "visible", timeout: 30_000 });

  await captureScreenshot(page, "fork-tree");
});
