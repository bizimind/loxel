import picomatch from "picomatch";

import type { FileAssociation } from "@/store/settings-store";

import { detectLanguage } from "./highlighter";

/**
 * Resolve the effective language for a file path, optionally sniffing content
 * when extension-based detection fails.
 *
 * Resolution order:
 * 1. Enabled file associations (first glob match wins)
 * 2. Filename/extension lookup via detectLanguage()
 * 3. Content-based sniffing (shebangs, XML prologs, etc.) — only when content is provided
 */
export function resolveLanguage(
  filePath: string,
  associations: FileAssociation[],
  content?: string | null,
): string | null {
  const filename = filePath.split("/").pop() ?? "";

  for (const assoc of associations) {
    if (!assoc.enabled) continue;
    // `dot` lets `**` cross dot directories (`.worktrees/`, `.vscode/`) and `*` match dotfiles.
    if (
      picomatch.isMatch(filePath, assoc.glob, { dot: true }) ||
      picomatch.isMatch(filename, assoc.glob, { dot: true })
    ) {
      return assoc.language;
    }
  }

  return detectLanguage(filePath) ?? (content ? sniffLanguageFromContent(content) : null);
}

/** Whether only a file's content can name its language: its path names none (a shebang script). */
export function languageNeedsContent(filePath: string, associations: FileAssociation[]): boolean {
  return resolveLanguage(filePath, associations) === null;
}

// -- Content-based language sniffing ------------------------------------------

const SHEBANG_MAP: Record<string, string> = {
  bash: "bash",
  sh: "bash",
  zsh: "bash",
  fish: "bash",
  python: "python",
  python3: "python",
  node: "javascript",
  nodejs: "javascript",
  bun: "javascript",
  deno: "typescript",
  // Runners, named for what they run: `tsx` runs TypeScript, not only the JSX dialect.
  tsx: "typescript",
  "ts-node": "typescript",
  "ts-node-esm": "typescript",
  "ts-node-script": "typescript",
  "ts-node-cwd": "typescript",
  "ts-node-transpile-only": "typescript",
  ruby: "ruby",
  perl: "perl",
  php: "php",
};

/** Commands that run the program named after them, as `env` does. */
const SHEBANG_LAUNCHERS = new Set(["env", "npx", "pnpx", "bunx"]);
/** `env`'s and the launchers' options (`-S`, `--yes`) and `env`'s `NAME=value` assignments. */
const SHEBANG_LAUNCHER_ARG = /^(?:-|\w+=)/;
/** The launcher options whose value is the next word. */
const SHEBANG_OPTIONS_WITH_VALUE = new Set(["-u", "--unset", "-C", "--chdir", "-p", "--package"]);

/** The name of the program a shebang line runs: `#!/usr/bin/env -S node --flag` is `node`. */
function shebangInterpreter(head: string): string | null {
  if (!head.startsWith("#!")) return null;
  const line = head.slice(2).split("\n")[0] ?? "";
  // `env -Snode` splits like `env -S node`.
  const words = line
    .replace(/\s-S(?=\S)/, " -S ")
    .split(/\s+/)
    .filter(Boolean);
  let index = 0;
  while (index < words.length) {
    const name = words[index]?.split("/").pop() ?? "";
    if (!SHEBANG_LAUNCHERS.has(name)) return name;
    index++;
    while (SHEBANG_LAUNCHER_ARG.test(words[index] ?? "")) {
      index += SHEBANG_OPTIONS_WITH_VALUE.has(words[index] ?? "") ? 2 : 1;
    }
  }
  return null;
}

const XML_PROLOG = /^\s*<\?xml\s/;
const XML_ROOT = /^\s*<[a-zA-Z]/;

function sniffLanguageFromContent(content: string): string | null {
  const head = content.slice(0, 256);

  const interpreter = shebangInterpreter(head);
  if (interpreter && Object.hasOwn(SHEBANG_MAP, interpreter)) return SHEBANG_MAP[interpreter]!;

  if (XML_PROLOG.test(head) || (XML_ROOT.test(head) && head.includes("</"))) {
    return "xml";
  }

  return null;
}
