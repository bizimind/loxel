/** Shared protocol types for the TypeScript LanguageService HTTP API. */

export interface CompletionEntryInfo {
  name: string;
  kind: string;
  sortText: string;
  insertText?: string;
  replacementSpan?: { startLine: number; startCol: number; endLine: number; endCol: number };
  isRecommended?: boolean;
  source?: string;
  /** Opaque token from TS CompletionEntry — round-trips through JSON for resolve. */
  data?: unknown;
  /** Semicolon-separated modifiers (e.g. "deprecated", "declare", "optional"). */
  kindModifiers?: string;
  /** Structured label parts for inline type info (method signatures, return types). */
  labelDetails?: LabelDetails;
}

/** Label detail + description extracted from TS displayParts. */
export type LabelDetails = { detail?: string; description?: string };

export interface CompletionsResult {
  entries: CompletionEntryInfo[];
  isIncomplete: boolean;
}

export interface CompletionEntryDetailsResult {
  name: string;
  kind: string;
  displayParts: string;
  documentation: string;
}

export interface ReferenceLocation {
  filePath: string;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  isDefinition: boolean;
}

export interface ReferencesResult {
  references: ReferenceLocation[];
}
