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
  // The homepage's screenshots are encoded at 7 widths in two formats; sharp's default effort makes
  // that minutes of CPU on a CI runner. Lower effort costs about a tenth more bytes and encodes
  // several times faster. CI also caches the results (release-site.yml).
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
