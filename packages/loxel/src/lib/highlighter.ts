import { createHighlighter, type Highlighter } from "shiki";

// Singleton highlighter instance
let highlighterPromise: Promise<Highlighter> | null = null;

// Common languages for code repositories
const BUNDLED_LANGUAGES = [
  "javascript",
  "typescript",
  "tsx",
  "jsx",
  "json",
  "jsonc",
  "jsonl",
  "html",
  "css",
  "scss",
  "markdown",
  "yaml",
  "toml",
  "ini",
  "python",
  "rust",
  "go",
  "java",
  "c",
  "cpp",
  "csharp",
  "swift",
  "kotlin",
  "ruby",
  "php",
  "sql",
  "shell",
  "bash",
  "dockerfile",
  "terraform",
  "graphql",
  "vue",
  "svelte",
  "dotenv",
] as const;

/**
 * Get or create the singleton highlighter instance.
 */
export async function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ["github-dark", "github-light"],
      langs: [...BUNDLED_LANGUAGES],
    });
  }
  return highlighterPromise;
}

// Special filename to language mapping (case-insensitive)
export const FILENAME_TO_LANG: Record<string, string> = {
  // Lock files
  "bun.lock": "json",
  "bun.lockb": "json",
  "package-lock.json": "json",
  "composer.lock": "json",
  "cargo.lock": "toml",
  "poetry.lock": "toml",
  "gemfile.lock": "ruby",
  "yarn.lock": "yaml",

  // Ruby files
  gemfile: "ruby",
  rakefile: "ruby",
  brewfile: "ruby",
  vagrantfile: "ruby",
  podfile: "ruby",
  fastfile: "ruby",
  appfile: "ruby",
  matchfile: "ruby",
  guardfile: "ruby",

  // Config files
  dockerfile: "dockerfile",
  containerfile: "dockerfile",
  "docker-bake.hcl": "dockerbake",
  "docker-bake.override.hcl": "dockerbake",
  makefile: "shell",
  justfile: "shell",
  procfile: "yaml",
  caddyfile: "ini",

  // RC files (JSON-based)
  ".babelrc": "json",
  ".prettierrc": "json",
  ".eslintrc": "json",
  ".stylelintrc": "json",
  ".markdownlintrc": "json",
  ".htmlhintrc": "json",
  ".swcrc": "json",

  // RC files (YAML-based)
  ".clang-format": "yaml",
  ".clang-tidy": "yaml",
  ".yamllint": "yaml",

  // RC files (INI-based)
  ".npmrc": "ini",
  ".yarnrc": "ini",
  ".editorconfig": "ini",
  ".gitattributes": "ini",
  ".gitmodules": "ini",
  ".mailmap": "ini",
  ".browserslistrc": "ini",

  // Ignore files
  ".gitignore": "ini",
  ".dockerignore": "ini",
  ".prettierignore": "ini",
  ".eslintignore": "ini",
  ".npmignore": "ini",
  ".vercelignore": "ini",

  // Docs without extension
  readme: "markdown",
  changelog: "markdown",
  history: "markdown",
  authors: "markdown",
  contributors: "markdown",
  license: "markdown",
  copying: "markdown",
  code_of_conduct: "markdown",
  contributing: "markdown",
};

// File extension to language mapping
export const EXT_TO_LANG: Record<string, string> = {
  // JavaScript/TypeScript
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  jsx: "jsx",

  // Web
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  sass: "scss",
  less: "css",
  vue: "vue",
  svelte: "svelte",

  // Data formats
  json: "json",
  jsonc: "jsonc",
  jsonl: "jsonl",
  ndjson: "jsonl",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  xml: "html",
  env: "dotenv",

  // Docs
  md: "markdown",
  mdx: "markdown",

  // Systems
  rs: "rust",
  go: "go",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",

  // JVM
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  scala: "java",

  // Scripting
  py: "python",
  rb: "ruby",
  php: "php",

  // Mobile
  swift: "swift",
  m: "c",
  mm: "cpp",

  // Shell
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "bash",

  // Config
  dockerfile: "dockerfile",
  graphql: "graphql",
  gql: "graphql",
  sql: "sql",

  // Infrastructure-as-code
  tf: "terraform",
  tfvars: "terraform",
  hcl: "terraform",
};

/**
 * Detect the language from a file path.
 */
export function detectLanguage(filePath: string): string | null {
  const filename = filePath.split("/").pop()?.toLowerCase() ?? "";

  // Check exact filename match first
  if (FILENAME_TO_LANG[filename]) {
    return FILENAME_TO_LANG[filename];
  }

  // Handle TypeScript declaration files
  if (filename.endsWith(".d.ts")) return "typescript";

  // Handle .env variants (.env, .env.local, .env.production, etc.)
  if (filename === ".env" || filename.startsWith(".env.")) return "dotenv";

  // Extract extension and look up
  const ext = filename.split(".").pop()?.toLowerCase();
  if (!ext) return null;

  return EXT_TO_LANG[ext] ?? null;
}

export interface HighlightedLine {
  html: string;
}

/**
 * Highlight code and return tokens for each line.
 */
export async function highlightCode(
  code: string,
  language: string,
  theme: "github-dark" | "github-light",
): Promise<HighlightedLine[]> {
  const highlighter = await getHighlighter();

  // Check if language is loaded
  const loadedLangs = highlighter.getLoadedLanguages();
  if (!loadedLangs.includes(language)) {
    // Return unhighlighted lines
    return code.split("\n").map((line) => ({ html: escapeHtml(line) }));
  }

  const result = highlighter.codeToTokens(code, {
    lang: language as Parameters<typeof highlighter.codeToTokens>[1]["lang"],
    theme,
  });

  return result.tokens.map((lineTokens) => {
    const html = lineTokens
      .map((token) => {
        const style = token.color ? `color: ${token.color}` : "";
        return style
          ? `<span style="${style}">${escapeHtml(token.content)}</span>`
          : escapeHtml(token.content);
      })
      .join("");
    return { html };
  });
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
