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
}

export const DEFAULT_FORMATTING_SETTINGS: FormattingSettings = {
  enabled: true,
  formatOnAutoSave: false,
  autoDetect: true,
  overrides: [],
};
