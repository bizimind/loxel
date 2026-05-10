import { test } from "@playwright/test";

import { captureScreenshot } from "../helpers/screenshot";
import { waitForLoxel } from "../helpers/server";

const DEMO_PROJECT_PATH = `${process.env.HOME}/.loxel-demo/my-project`;

test("commit graph screenshot", async ({ page, request }) => {
  // Register the demo project so the commit graph has rich branching history.
  await request.post("/api/projects", { data: { path: DEMO_PROJECT_PATH, name: "my-project" } });

  await waitForLoxel(page);

  // Open the Git panel via its toolbar icon (title="Git").
  await page.getByTitle("Git").click();

  // Wait for at least one commit row to appear. Commit rows are absolutely
  // positioned divs inside the scrollable graph area. Each one carries a
  // `title` on its subject cell that equals the commit message, so we wait
  // for any element whose title matches a known commit from the demo repo.
  await page
    .locator('[title="feat: add product recommendations to product detail page"]')
    .waitFor({ state: "visible" });

  await captureScreenshot(page, "commit-graph");
});
