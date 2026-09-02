import { satteri } from "@astrojs/markdown-satteri";
import mdx from "@astrojs/mdx";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

import { satteriKbd } from "./src/lib/satteri-kbd.ts";

export default defineConfig({
  site: "https://bizimind.io",
  output: "static",
  prefetch: true,
  integrations: [react(), mdx(), sitemap()],
  markdown: { processor: satteri({ hastPlugins: [satteriKbd] }) },
  vite: { plugins: [tailwindcss()] },
});
