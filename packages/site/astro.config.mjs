import { satteri } from "@astrojs/markdown-satteri";
import mdx from "@astrojs/mdx";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, envField } from "astro/config";

import { satteriKbd } from "./src/lib/satteri-kbd.ts";

export default defineConfig({
  site: "https://bizimind.io",
  output: "static",
  prefetch: true,
  trailingSlash: "never",
  build: { format: "file" },
  // Renamed pages keep their old URLs working; /docs has no page of its own.
  redirects: {
    "/docs": "/docs/getting-started",
    "/docs/typescript-intelligence": "/docs/language-intelligence",
    "/docs/coding-agent": "/docs/terminals#tui-agents",
  },
  integrations: [react(), mdx(), sitemap()],
  markdown: { processor: satteri({ hastPlugins: [satteriKbd] }) },
  vite: { plugins: [tailwindcss()] },
  env: {
    schema: {
      // PostHog project key; builds without it send no analytics (see src/lib/analytics.ts).
      PUBLIC_POSTHOG_KEY: envField.string({ context: "client", access: "public", optional: true }),
    },
  },
});
