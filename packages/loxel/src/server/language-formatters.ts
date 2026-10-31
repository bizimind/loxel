/**
 * Every language's format-on-save module: one import and one entry per module, both sorted. Only
 * lists belong in this file: a local `git merge` combines parallel additions by itself
 * (`merge=union` in `.gitattributes`). GitHub's own merge ignores that and reports a conflict when
 * two branches insert at the same spot; merging main locally then needs no edits.
 */
import { csharpFormatter } from "./csharp-formatter";
import { goFormatter } from "./go-formatter";
import type { LanguageFormatter } from "./language-formatter";
import { pythonFormatter } from "./python-formatter";

export const languageFormatters: readonly LanguageFormatter[] = [
  // This comment keeps the formatter from joining the entries onto one line.
  csharpFormatter,
  goFormatter,
  pythonFormatter,
];
