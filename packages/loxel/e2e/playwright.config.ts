import { defineConfig } from "@playwright/test";

/** The `Authorization` with the e2e server's session secret, which global-setup.ts reads. */
const authorization = process.env.LOXEL_E2E_AUTHORIZATION ?? "";

export default defineConfig({
  globalSetup: "./global-setup.ts",
  globalTeardown: "./global-teardown.ts",
  // Failure artifacts only. Screenshots are written by the specs (helpers/screenshot.ts); pointing this
  // at the site's screenshots folder would let Playwright empty it at the start of every run.
  outputDir: "test-results",
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
        // As Electron main does for the app's windows: on every request, WebSocket upgrades too,
        // and for the `request` fixture.
        extraHTTPHeaders: { Authorization: authorization },
      },
    },
  ],
});
