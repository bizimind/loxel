import { defineConfig } from "@playwright/test";

export default defineConfig({
  globalSetup: "./global-setup.ts",
  globalTeardown: "./global-teardown.ts",
  outputDir: "../../site/public/screenshots",
  timeout: 30_000,
  retries: 0,
  // Tests share a single server instance — run sequentially to avoid state interference.
  workers: 1,
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 2,
        screenshot: "only-on-failure",
        actionTimeout: 60_000,
        baseURL: `http://localhost:${process.env.LOXEL_PORT ?? 7434}`,
      },
    },
  ],
});
