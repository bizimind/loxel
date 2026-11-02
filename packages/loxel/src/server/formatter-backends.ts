export type BackendMode = "command" | "lsp" | "library";

/** The formatter is fine and refused this content, so running it another way would not help. */
export const FORMAT_REJECTED = Symbol("format-rejected");

/** The formatted text, {@link FORMAT_REJECTED}, or null when the backend itself failed. */
export type FormatterResult = string | typeof FORMAT_REJECTED | null;

/**
 * End a formatter spawned with `detached` and everything it started, none of which may outlive it:
 * SIGKILL since a project's code could ignore a polite signal, and the group since a child would
 * keep running that code and hold the pipes a save waits on.
 */
export function killProcessGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

export interface FormatterBackend {
  /** Format content. `filePath` is absolute. */
  format(content: string, filePath: string): Promise<FormatterResult>;
  /** Whether the backend is currently alive/usable. */
  isAlive(): boolean;
  /** Stop for good, ending whatever it runs. Requests in flight resolve to null. */
  destroy(): void;
}
