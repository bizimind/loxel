// Site identity shared by the page head, structured data and links.
export const SITE_NAME = "Loxel";
// The home page's description, which its hero repeats, and the default for pages without their own.
export const SITE_DESCRIPTION =
  "Orchestrate dozens of coding agents from one window. Every task keeps its worktree, terminals, browser tabs, and files, and the code is a glance away when it's yours to own.";
// The home page's title; other pages are titled "<page> — Loxel".
export const HOME_TITLE = "Loxel — The professional workspace for AI-powered development";
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
