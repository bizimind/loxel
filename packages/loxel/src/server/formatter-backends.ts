export type BackendMode = "command" | "lsp" | "library";

export interface FormatterBackend {
  /** Format content. Returns formatted string or null on failure. */
  format(content: string, filePath: string): Promise<string | null>;
  /** Whether the backend is currently alive/usable. */
  isAlive(): boolean;
  /** Gracefully shut down. */
  destroy(): void;
}
