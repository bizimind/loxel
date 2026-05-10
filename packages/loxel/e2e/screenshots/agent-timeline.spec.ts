import { test } from "@playwright/test";

import { captureScreenshot } from "../helpers/screenshot";
import { waitForLoxel } from "../helpers/server";

const DEMO_PROJECT_PATH = `${process.env.HOME}/.loxel-demo/my-project`;

/**
 * Agent timeline screenshot.
 *
 * Registers the demo project, opens a new agent panel, sends a message, and
 * waits for the first visible output (user message bubble or assistant/tool item)
 * before capturing. The coding agent is a local runtime with no external API
 * dependencies — no API key is required.
 */
test("agent timeline screenshot", async ({ page, request }) => {
  // Register the demo project so the agent has a workspace root.
  await request.post("/api/projects", { data: { path: DEMO_PROJECT_PATH, name: "my-project" } });

  await waitForLoxel(page);

  // Open a new agent panel via the "New Agent" button in the status bar.
  await page.getByTitle("New Agent").click();

  // Wait for the input textarea to appear — confirms the panel mounted.
  const inputArea = page.locator("textarea").first();
  await inputArea.waitFor({ state: "visible", timeout: 10_000 });

  // Type and send a message so the timeline populates with real output.
  await inputArea.fill("List the main components in this project and describe what each one does");
  await inputArea.press("Enter");

  // Wait for the user message bubble to appear in the timeline (optimistic UI).
  // User messages render inside a .bg-card bubble.
  await page.locator(".bg-card").first().waitFor({ state: "visible", timeout: 15_000 });

  // Wait for at least one timeline row (assistant message, tool call, or reasoning)
  // to appear — confirms the agent has begun responding.
  await page.locator(".group\\/row").first().waitFor({ state: "visible", timeout: 60_000 });

  await captureScreenshot(page, "agent-timeline");
});
