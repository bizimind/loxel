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
