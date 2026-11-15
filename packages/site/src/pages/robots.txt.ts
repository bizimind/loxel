import type { APIRoute } from "astro";

// Crawl everything; the sitemap URL follows `site` in astro.config.mjs.
export const GET: APIRoute = ({ site }) => {
  const sitemap = new URL("/sitemap-index.xml", site);
  return new Response(`User-agent: *\nAllow: /\n\nSitemap: ${sitemap.href}\n`);
};
