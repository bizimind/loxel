/**
 * Centralized output handling for CLI commands.
 *
 * All CLI output should go through OutputContext to ensure consistent
 * behavior across human/json/quiet modes. This enables:
 * - Consistent output formatting
 * - Clean JSON output without progress noise
 * - Quiet mode that suppresses non-essential output
 * - Future linter rules to forbid direct console/process.stdout/stderr
 *
 * Note: Final result output (JSON or human) is handled by runAction/printResult.
 * OutputContext is for progress logging during command execution.
 */

export type OutputMode = "human" | "json" | "quiet";

export interface OutputContext {
  readonly mode: OutputMode;

  /**
   * Log informational/progress message.
   * - human: stdout
   * - json: stderr (keeps stdout clean for JSON)
   * - quiet: suppressed
   */
  log(this: void, message: string): void;

  /**
   * Log warning (to stderr).
   * - human/json: stderr
   * - quiet: suppressed
   */
  warn(this: void, message: string): void;
}

/**
 * Create an output context for the given mode.
 */
export function createOutputContext(mode: OutputMode): OutputContext {
  return {
    mode,

    log(msg: string): void {
      if (mode === "human") {
        process.stdout.write(msg + "\n");
      } else if (mode === "json") {
        process.stderr.write(msg + "\n");
      }
      // quiet: suppressed
    },

    warn(msg: string): void {
      if (mode !== "quiet") {
        process.stderr.write(msg + "\n");
      }
    },
  };
}

/**
 * Determine output mode from CLI flags.
 */
export function getOutputMode(opts: { json?: boolean; quiet?: boolean }): OutputMode {
  if (opts.json) return "json";
  if (opts.quiet) return "quiet";
  return "human";
}
