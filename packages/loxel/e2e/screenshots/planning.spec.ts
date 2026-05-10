import { test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";

import { captureScreenshot } from "../helpers/screenshot";
import { waitForLoxel } from "../helpers/server";

const DEMO_PROJECT_PATH = `${homedir()}/.loxel-demo/my-project`;

const PLANNING_CONTENT = `# AI Recommendations Feature

## Goals
- [ ] Integrate product embedding model
- [ ] Build similarity search API endpoint
- [x] Define data schema for user interactions

## Architecture

The recommendation engine will use cosine similarity on product embeddings.
Results are ranked by similarity score and filtered by stock availability.

## API Design

\`\`\`typescript
interface RecommendationRequest {
  productId: string;
  userId?: string;
  limit: number;
}
\`\`\`

## Timeline
- Week 1: Data pipeline + embeddings
- Week 2: API endpoint + caching
- Week 3: Frontend integration
`;

test("planning markdown screenshot", async ({ page, request }) => {
  // Register the demo project.
  await request.post("/api/projects", { data: { path: DEMO_PROJECT_PATH, name: "my-project" } });

  // Write a realistic planning document to disk before the app loads it.
  writeFileSync(`${DEMO_PROJECT_PATH}/PLANNING.md`, PLANNING_CONTENT, "utf8");

  await waitForLoxel(page);

  // Open a new markdown editor panel via the create event.
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("loxel-create-editor"));
  });

  // Wait for the ProseMirror editor (milkdown) to mount.
  await page.locator(".ProseMirror").first().waitFor({ state: "visible" });

  // Load the PLANNING.md file into the editor via the open event.
  await page.evaluate((planningPath) => {
    window.dispatchEvent(
      new CustomEvent("loxel-open-markdown-editor", { detail: { filePath: planningPath } }),
    );
  }, `${DEMO_PROJECT_PATH}/PLANNING.md`);

  // Wait for the editor content to reflect the planning document.
  await page
    .locator(".ProseMirror")
    .first()
    .filter({ hasText: "AI Recommendations Feature" })
    .waitFor({ state: "visible" });

  await captureScreenshot(page, "planning-markdown");
});
