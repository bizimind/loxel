import { test } from "@playwright/test";

import { captureScreenshot } from "../helpers/screenshot";
import { waitForLoxel } from "../helpers/server";

const DEMO_PROJECT_PATH = `${process.env.HOME}/.loxel-demo/my-project`;

test("hero screenshot", async ({ page, request }) => {
  // Register the demo project so the app has something to show.
  await request.post("/api/projects", { data: { path: DEMO_PROJECT_PATH, name: "my-project" } });

  await waitForLoxel(page);
  await captureScreenshot(page, "hero");
});
