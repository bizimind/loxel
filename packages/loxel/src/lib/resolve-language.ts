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
    if (picomatch.isMatch(filePath, assoc.glob) || picomatch.isMatch(filename, assoc.glob)) {
      return assoc.language;
    }
  }

  return detectLanguage(filePath) ?? (content ? sniffLanguageFromContent(content) : null);
}

// -- Content-based language sniffing ------------------------------------------

const SHEBANG_RE = /^#!\s*(?:\/usr\/bin\/env\s+)?(\S+)/;

const SHEBANG_MAP: Record<string, string> = {
  bash: "bash",
  sh: "bash",
  zsh: "bash",
  fish: "bash",
  python: "python",
  python3: "python",
  node: "javascript",
  bun: "javascript",
  deno: "typescript",
  ruby: "ruby",
  perl: "perl",
  php: "php",
};

const XML_PROLOG = /^\s*<\?xml\s/;
const XML_ROOT = /^\s*<[a-zA-Z]/;

function sniffLanguageFromContent(content: string): string | null {
  const head = content.slice(0, 256);

  const shebang = SHEBANG_RE.exec(head)?.[1];
  if (shebang) {
    const bin = shebang.split("/").pop() ?? shebang;
    const lang = SHEBANG_MAP[bin];
    if (lang) return lang;
  }

  if (XML_PROLOG.test(head) || (XML_ROOT.test(head) && head.includes("</"))) {
    return "xml";
  }

  return null;
}
