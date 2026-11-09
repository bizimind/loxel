import { writeFile } from "node:fs/promises";

import { satteri } from "@astrojs/markdown-satteri";
import mdx from "@astrojs/mdx";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, envField, fontProviders } from "astro/config";

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

// Renamed pages keep their old URLs working; /docs has no page of its own.
const redirects = {
  "/docs": "/docs/getting-started",
  "/docs/typescript-intelligence": "/docs/language-intelligence",
  "/docs/coding-agent": "/docs/coding-agents",
  "/docs/worktrees-and-projects": "/docs/worktrees-and-tasks",
  "/docs/guide-parallel-workstreams": "/docs/parallel-tasks",
};

// A static build writes each `redirects` entry as a meta-refresh page, which drops the URL's
// #fragment, so `/docs/old-page#section` would land at the top of the new page. Cloudflare Pages
// serves the same entries from `_redirects` as real 301s instead (applied before any asset, so the
// meta-refresh pages don't shadow them), and browsers carry the fragment across a redirect; the new
// page's `movedAnchors` then maps renamed ones. The meta-refresh pages stay for `astro dev`.
/** @type {import("astro").AstroIntegration} */
const cloudflareRedirects = {
  name: "cloudflare-redirects",
  hooks: {
    "astro:build:done": async ({ dir }) => {
      const rules = Object.entries(redirects).map(([from, to]) => `${from} ${to} 301`);
      await writeFile(new URL("_redirects", dir), `${rules.join("\n")}\n`);
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
  redirects,
  integrations: [mdx(), sitemap(), siteScript, cloudflareRedirects],
  // The homepage's screenshots are encoded at 7 widths in two formats; sharp's default effort makes
  // that minutes of CPU on a CI runner. Lower effort costs about a tenth more bytes and encodes
  // several times faster.
  image: {
    service: {
      entrypoint: "astro/assets/services/sharp",
      config: { avif: { effort: 2 }, webp: { effort: 2 } },
    },
  },
  // Self-hosted from the Fontsource packages (pinned by the lockfile, no fetch at build time), so
  // pages never contact a font CDN. Latin only: Latin Extended has no glyph the site uses (arrows
  // such as → are in neither and fall back to a system font), and one file per style keeps Inter's
  // preload (in Base.astro) to a single file. Astro generates size-adjusted fallback faces from
  // the last fallback; `sans-serif` (Arial) measured less layout shift than `system-ui`.
  fonts: [
    {
      name: "Inter",
      cssVariable: "--font-inter",
      provider: fontProviders.local(),
      fallbacks: ["sans-serif"],
      options: {
        variants: [
          {
            src: ["@fontsource-variable/inter/files/inter-latin-opsz-normal.woff2"],
            weight: "100 900",
            style: "normal",
          },
          {
            src: ["@fontsource-variable/inter/files/inter-latin-opsz-italic.woff2"],
            weight: "100 900",
            style: "italic",
          },
        ],
      },
    },
    {
      name: "JetBrains Mono",
      cssVariable: "--font-jetbrains-mono",
      provider: fontProviders.local(),
      fallbacks: ["monospace"],
      options: {
        variants: [
          {
            src: [
              "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2",
            ],
            weight: "100 800",
            style: "normal",
          },
          {
            src: [
              "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-italic.woff2",
            ],
            weight: "100 800",
            style: "italic",
          },
        ],
      },
    },
  ],
  markdown: { processor: satteri({ hastPlugins: [satteriKbd] }) },
  vite: { plugins: [tailwindcss()] },
  env: {
    schema: {
      // PostHog project key; builds without it send no analytics (see src/lib/analytics.ts).
      PUBLIC_POSTHOG_KEY: envField.string({ context: "client", access: "public", optional: true }),
    },
  },
});
