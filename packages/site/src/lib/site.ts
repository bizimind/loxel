// Site identity shared by the page head, structured data and links.
export const SITE_NAME = "Loxel";
export const SITE_DESCRIPTION = "The IDE built for developers who work with AI coding agents.";
export const ORG_NAME = "Bizimind";
export const GITHUB_ORG_URL = "https://github.com/bizimind";
export const GITHUB_REPO_URL = `${GITHUB_ORG_URL}/loxel`;
// Browser UI color; matches `--background` in src/styles/global.css.
export const THEME_COLOR = "#131313";

/**
 * The page's public path. With `build.format: "file"`, `Astro.url.pathname` ends in `.html` during
 * the build (`/docs/git.html`, `/index.html`), while the deployed URL has none (`/docs/git`, `/`).
 */
export function pagePath(url: URL): string {
  const path = url.pathname.replace(/(?:\/index)?\.html$/, "");
  return path === "" ? "/" : path;
}
