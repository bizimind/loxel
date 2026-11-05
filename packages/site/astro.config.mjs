import { satteri } from "@astrojs/markdown-satteri";
import mdx from "@astrojs/mdx";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, envField } from "astro/config";

import { satteriKbd } from "./src/lib/satteri-kbd.ts";

// Runs analytics on every page from Astro's page-script bundle, which also holds the prefetch
// script, so each page loads one script instead of two.
/** @type {import("astro").AstroIntegration} */
const siteScript = {
  name: "site-script",
  hooks: {
    "astro:config:setup": ({ injectScript }) => {
      injectScript(
        "page",
        'import { initAnalytics } from "/src/lib/analytics.ts"; initAnalytics();',
      );
    },
  },
};

export default defineConfig({
  site: "https://bizimind.io",
  output: "static",
  prefetch: true,
  trailingSlash: "never",
  // Inlined: the stylesheet is small, and a <link> to it would block the first render.
  build: { format: "file", inlineStylesheets: "always" },
  // Renamed pages keep their old URLs working; /docs has no page of its own.
  redirects: {
    "/docs": "/docs/getting-started",
    "/docs/typescript-intelligence": "/docs/language-intelligence",
    "/docs/coding-agent": "/docs/terminals#tui-agents",
  },
  integrations: [mdx(), sitemap(), siteScript],
  markdown: { processor: satteri({ hastPlugins: [satteriKbd] }) },
  vite: { plugins: [tailwindcss()] },
  env: {
    schema: {
      // PostHog project key; builds without it send no analytics (see src/lib/analytics.ts).
      PUBLIC_POSTHOG_KEY: envField.string({ context: "client", access: "public", optional: true }),
    },
  },
});
