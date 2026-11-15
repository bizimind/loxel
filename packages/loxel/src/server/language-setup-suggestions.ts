/**
 * Every language's workspace setup commands: one import and one entry per language, both sorted.
 * Commands are suggested in this order. Only lists belong in this file: a local `git merge`
 * combines parallel additions by itself (`merge=union` in `.gitattributes`). GitHub's own merge
 * ignores that and reports a conflict when two branches insert at the same spot; merging main
 * locally then needs no edits.
 */
import { csharpSetupCommands } from "./csharp-setup-suggestions";
import { pythonSetupCommands } from "./python-setup-suggestions";
import type { LanguageSetupCommands } from "./setup-suggestions";

export const languageSetupCommands: readonly LanguageSetupCommands[] = [
  // This comment keeps the list on one line per entry whatever its length.
  csharpSetupCommands,
  pythonSetupCommands,
];
