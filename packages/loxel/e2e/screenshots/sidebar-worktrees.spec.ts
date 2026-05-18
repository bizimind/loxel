import { homedir } from "node:os";
import { resolve } from "node:path";

import { test } from "@playwright/test";

import { captureScreenshot } from "../helpers/screenshot";
import { waitForLoxel } from "../helpers/server";

const DEMO_PROJECT = resolve(homedir(), ".loxel-demo/my-project");

const EXTRA_PROJECTS = [
  resolve(homedir(), ".loxel-demo/my-project-feat-ai-recommendations"),
  resolve(homedir(), ".loxel-demo/my-project-fix-cart-bug"),
  resolve(homedir(), ".loxel-demo/my-project-chore-update-deps"),
];

test("sidebar-worktrees screenshot", async ({ page, baseURL }) => {
  const base = baseURL ?? `http://localhost:${process.env.LOXEL_PORT ?? 7434}`;

  // Register the demo projects via the HTTP API before loading the UI.
  for (const projectPath of [DEMO_PROJECT, ...EXTRA_PROJECTS]) {
    await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: projectPath }),
    });
  }

  await waitForLoxel(page);

  // Ensure the sidebar is expanded — click the toggle if it shows "Expand sidebar".
  const expandBtn = page.getByTitle("Expand sidebar");
  if (await expandBtn.isVisible()) {
    await expandBtn.click();
  }

  // Wait for the sidebar to show at least one project entry.
  await page.waitForSelector('[title="Collapse sidebar"]', { timeout: 10_000 });

  // Wait for the demo project name to appear in the sidebar.
  await page
    .getByText("my-project", { exact: false })
    .first()
    .waitFor({ state: "visible", timeout: 15_000 });

  // Allow the project list to fully settle.
  await page.waitForLoadState("networkidle");

  await captureScreenshot(page, "sidebar-worktrees");
});
