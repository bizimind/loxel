import picomatch from "picomatch";

import type { FileAssociation } from "@/store/settings-store";

import { detectLanguage } from "./highlighter";

/**
 * Resolve the effective language for a file path.
 *
 * Resolution order:
 * 1. Enabled file associations (first glob match wins)
 * 2. Hardcoded detectLanguage() fallback (filename → extension)
 */
export function resolveLanguage(filePath: string, associations: FileAssociation[]): string | null {
  const filename = filePath.split("/").pop() ?? "";

  for (const assoc of associations) {
    if (!assoc.enabled) continue;
    if (picomatch.isMatch(filePath, assoc.glob) || picomatch.isMatch(filename, assoc.glob)) {
      return assoc.language;
    }
  }

  return detectLanguage(filePath);
}

const XML_PROLOG = /^\s*<\?xml\s/;
const XML_ROOT = /^\s*<[a-zA-Z]/;

/**
 * Sniff file content to detect XML when extension-based detection returns
 * null or plaintext. Only checks the first 200 chars for performance.
 */
export function sniffLanguageFromContent(content: string): string | null {
  const head = content.slice(0, 200);
  if (XML_PROLOG.test(head) || (XML_ROOT.test(head) && head.includes("</"))) {
    return "xml";
  }
  return null;
}
