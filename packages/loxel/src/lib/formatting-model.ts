import type { Options as ToMarkdownOptions } from "mdast-util-to-markdown";

export interface FormatterOverride {
  id: string;
  /** Comma-separated extensions without leading dot, e.g. "ts,tsx,js,jsx". */
  extensions: string;
  /** Command to run. Receives content on stdin, outputs formatted content on stdout. */
  command: string;
  /** Extra args. Supports placeholders: {file} → absolute path, {ext} → extension. */
  args: string;
}

export interface FormattingSettings {
  /** Format on explicit save (Cmd+S, flush on worktree switch, etc.). Default: true. */
  enabled: boolean;
  /** Also format on auto-save (debounced from user typing). Default: false. */
  formatOnAutoSave: boolean;
  /** Whether to auto-detect formatters from project config files. Default: true. */
  autoDetect: boolean;
  /** Manual per-extension overrides (highest priority over auto-detect). */
  overrides: FormatterOverride[];
  /**
   * Markers the markdown editor emits when serializing. Only matters when no markdown
   * formatter rewrites the file on save (formatters normalize markers themselves).
   */
  markdownOutput: MarkdownOutputSettings;
}

/** The subset the server needs to format on save; `markdownOutput` is editor-only. */
export type FormatOnSaveSettings = Omit<FormattingSettings, "markdownOutput">;

type MarkdownOutputKey =
  | "bullet"
  | "bulletOrdered"
  | "incrementListMarker"
  | "emphasis"
  | "strong"
  | "fence"
  | "rule"
  | "listItemIndent"
  | "setext";

/** Subset of `mdast-util-to-markdown` options exposed to the user, with nulls removed. */
export type MarkdownOutputSettings = {
  [K in MarkdownOutputKey]: NonNullable<ToMarkdownOptions[K]>;
};

export type MarkdownOutputChoiceKey = Exclude<MarkdownOutputKey, "incrementListMarker" | "setext">;

/** Allowed values per marker option — runtime counterpart of `MarkdownOutputSettings`. */
export const MARKDOWN_OUTPUT_CHOICES = {
  bullet: ["-", "*", "+"],
  bulletOrdered: [".", ")"],
  emphasis: ["_", "*"],
  strong: ["*", "_"],
  fence: ["`", "~"],
  rule: ["-", "*", "_"],
  listItemIndent: ["one", "tab", "mixed"],
} as const satisfies {
  [K in MarkdownOutputChoiceKey]: readonly MarkdownOutputSettings[K][];
};

/** Matches Prettier/oxfmt markdown output so unformatted saves look the same as formatted ones. */
export const DEFAULT_MARKDOWN_OUTPUT_SETTINGS: MarkdownOutputSettings = {
  bullet: "-",
  bulletOrdered: ".",
  incrementListMarker: true,
  emphasis: "_",
  strong: "*",
  fence: "`",
  rule: "-",
  listItemIndent: "one",
  setext: false,
};

/** Type guard: `value` is one of the allowed choices for marker option `key`. */
export function isMarkdownOutputChoice<K extends MarkdownOutputChoiceKey>(
  key: K,
  value: unknown,
): value is MarkdownOutputSettings[K] {
  const choices: readonly string[] = MARKDOWN_OUTPUT_CHOICES[key];
  return typeof value === "string" && choices.includes(value);
}

/** Narrow untrusted (persisted) data to `MarkdownOutputSettings`, falling back to defaults per key. */
export function parseMarkdownOutputSettings(input: unknown): MarkdownOutputSettings {
  const raw: Record<string, unknown> =
    typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const d = DEFAULT_MARKDOWN_OUTPUT_SETTINGS;
  return {
    bullet: isMarkdownOutputChoice("bullet", raw.bullet) ? raw.bullet : d.bullet,
    bulletOrdered: isMarkdownOutputChoice("bulletOrdered", raw.bulletOrdered)
      ? raw.bulletOrdered
      : d.bulletOrdered,
    incrementListMarker:
      typeof raw.incrementListMarker === "boolean"
        ? raw.incrementListMarker
        : d.incrementListMarker,
    emphasis: isMarkdownOutputChoice("emphasis", raw.emphasis) ? raw.emphasis : d.emphasis,
    strong: isMarkdownOutputChoice("strong", raw.strong) ? raw.strong : d.strong,
    fence: isMarkdownOutputChoice("fence", raw.fence) ? raw.fence : d.fence,
    rule: isMarkdownOutputChoice("rule", raw.rule) ? raw.rule : d.rule,
    listItemIndent: isMarkdownOutputChoice("listItemIndent", raw.listItemIndent)
      ? raw.listItemIndent
      : d.listItemIndent,
    setext: typeof raw.setext === "boolean" ? raw.setext : d.setext,
  };
}

export const DEFAULT_FORMATTING_SETTINGS: FormattingSettings = {
  enabled: true,
  formatOnAutoSave: false,
  autoDetect: true,
  overrides: [],
  markdownOutput: DEFAULT_MARKDOWN_OUTPUT_SETTINGS,
};
