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

/** A backend holds a process per directory, so one nobody saves in goes away. */
const IDLE_TIMEOUT_MS = 10 * 60_000;

/**
 * Calls `stop` once `touch` has not been called for `timeoutMs`, unless `isBusy` says a request is
 * still in flight. `clear` cancels it.
 */
export function idleTimer(
  isBusy: () => boolean,
  stop: () => void,
  timeoutMs = IDLE_TIMEOUT_MS,
): { touch: () => void; clear: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => clearTimeout(timer);
  const touch = () => {
    clear();
    timer = setTimeout(() => (isBusy() ? touch() : stop()), timeoutMs);
    timer.unref();
  };
  return { touch, clear };
}

export interface FormatterBackend {
  /** Format content. `filePath` is absolute. */
  format(content: string, filePath: string): Promise<FormatterResult>;
  /** Whether the backend is currently alive/usable. */
  isAlive(): boolean;
  /** Stop for good, ending whatever it runs. Requests in flight resolve to null. */
  destroy(): void;
}
