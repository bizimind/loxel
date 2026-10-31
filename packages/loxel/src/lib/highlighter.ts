import { createHighlighter, type Highlighter } from "shiki";

import { loxelDark } from "./loxel-themes";

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
  "cmake",
  "cpp",
  "csharp",
  "objective-c",
  "objective-cpp",
  "swift",
  "kotlin",
  "ruby",
  "php",
  "sql",
  "shell",
  "bash",
  "dockerfile",
  "make",
  "just",
  "terraform",
  "graphql",
  "vue",
  "svelte",
  "astro",
  "dotenv",
  "xml",
] as const;

/**
 * Get or create the singleton highlighter instance.
 */
export async function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [loxelDark, "github-dark"],
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
  "uv.lock": "toml",
  "pipfile.lock": "json",
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
  pipfile: "toml",
  dockerfile: "dockerfile",
  containerfile: "dockerfile",
  "docker-bake.hcl": "dockerbake",
  "docker-bake.override.hcl": "dockerbake",
  makefile: "make",
  gnumakefile: "make",
  "cmakelists.txt": "cmake",
  "cmakecache.txt": "ini",
  // One compiler flag per line with no comment syntax, so no grammar fits.
  "compile_flags.txt": "plaintext",
  justfile: "just",
  ".justfile": "just",
  "go.mod": "go.mod",
  "go.sum": "go.sum",
  "go.work": "go.work",
  "go.work.sum": "go.sum",
  procfile: "yaml",
  caddyfile: "ini",
  ".classpath": "xml",
  ".project": "xml",
  ".factorypath": "xml",

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
  "_clang-format": "yaml",
  ".clang-tidy": "yaml",
  ".clangd": "yaml",
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
  ".clang-format-ignore": "ini",

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
  astro: "astro",

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
  xml: "xml",
  xsd: "xml",
  xsl: "xml",
  xslt: "xml",
  wsdl: "xml",
  xhtml: "xml",
  plist: "xml",
  csproj: "xml",
  fsproj: "xml",
  vbproj: "xml",
  props: "xml",
  targets: "xml",
  nuspec: "xml",
  resx: "xml",
  xaml: "xml",
  axaml: "xml",
  axml: "xml",
  pom: "xml",
  fxml: "xml",
  tld: "xml",
  env: "dotenv",

  // Docs
  md: "markdown",
  mdx: "markdown",

  // Systems
  rs: "rust",
  go: "go",
  c: "c",
  i: "c",
  // Mostly C++ in practice, and the C++ grammar also covers C. Same choice as VS Code.
  h: "cpp",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  "c++": "cpp",
  ii: "cpp",
  ino: "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  "h++": "cpp",
  inl: "cpp",
  ipp: "cpp",
  tpp: "cpp",
  tcc: "cpp",
  txx: "cpp",
  ixx: "cpp",
  cppm: "cpp",
  ccm: "cpp",
  cxxm: "cpp",
  "c++m": "cpp",
  cs: "csharp",

  // JVM
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  scala: "java",

  // Scripting
  py: "python",
  pyi: "python",
  pyw: "python",
  rb: "ruby",
  php: "php",

  // Mobile
  swift: "swift",
  m: "objective-c",
  mm: "objective-cpp",

  // Shell
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "bash",

  // Config
  dockerfile: "dockerfile",
  mk: "make",
  cmake: "cmake",
  just: "just",
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
  const originalName = filePath.split("/").pop() ?? "";
  const filename = originalName.toLowerCase();

  // Check exact filename match first
  if (FILENAME_TO_LANG[filename]) {
    return FILENAME_TO_LANG[filename];
  }

  // Handle TypeScript declaration files
  if (filename.endsWith(".d.ts")) return "typescript";

  // Handle .env variants (.env, .env.local, .env.production, etc.)
  if (filename === ".env" || filename.startsWith(".env.")) return "dotenv";

  // The one case-sensitive extension: `.C` is C++, `.c` is C.
  if (originalName.endsWith(".C")) return "cpp";

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
