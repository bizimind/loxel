import mdx from "@astrojs/mdx";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

import { rehypeKbd } from "./src/lib/rehype-kbd.ts";

export default defineConfig({
  site: "https://bizimind.io",
  output: "static",
  prefetch: true,
  integrations: [react(), mdx(), sitemap()],
  markdown: { rehypePlugins: [rehypeKbd] },
  vite: { plugins: [tailwindcss()] },
});
