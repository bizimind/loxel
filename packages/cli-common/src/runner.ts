/**
 * Command runner that enforces CommandResult return type
 * and handles json/human/quiet output modes.
 */

import type { CommandResult } from "./result.ts";

import {
  createOutputContext,
  getOutputMode,
  type OutputContext,
  type OutputMode,
} from "./output.ts";
import { errorResult } from "./result.ts";

export interface RunOptions {
  json?: boolean;
  quiet?: boolean;
}

/**
 * Run a command action and handle output based on mode.
 * Sets process.exitCode instead of calling process.exit() to allow cleanup code to run.
 *
 * @example
 * .action(async (opts) => {
 *   await runAction(opts, async (ctx) => {
 *     ctx.log("Fetching data...");
 *     const data = await fetchVersion();
 *     return createResult(data, (d) => formatKeyValue(d));
 *   });
 * });
 */
export async function runAction<T>(
  opts: RunOptions,
  action: (ctx: OutputContext) => Promise<CommandResult<T>>,
): Promise<void> {
  const mode = getOutputMode(opts);
  const ctx = createOutputContext(mode);

  try {
    const result = await action(ctx);
    printResult(mode, result);
    process.exitCode = result.exitCode;
  } catch (err) {
    // Convert thrown errors to error result (backward compat during migration)
    const message = err instanceof Error ? err.message : String(err);
    const exitCode = (err as { code?: number }).code ?? 1;
    printResult(mode, errorResult(message, exitCode));
    process.exitCode = exitCode;
  }
}

/**
 * Synchronous version of runAction.
 */
export function runActionSync<T>(
  opts: RunOptions,
  action: (ctx: OutputContext) => CommandResult<T>,
): void {
  const mode = getOutputMode(opts);
  const ctx = createOutputContext(mode);

  try {
    const result = action(ctx);
    printResult(mode, result);
    process.exitCode = result.exitCode;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const exitCode = (err as { code?: number }).code ?? 1;
    printResult(mode, errorResult(message, exitCode));
    process.exitCode = exitCode;
  }
}

/**
 * Print a CommandResult based on the output mode.
 * Exported for testing.
 */
export function printResult<T>(mode: OutputMode, result: CommandResult<T>): void {
  switch (mode) {
    case "json":
      process.stdout.write(JSON.stringify(result.data, null, 2) + "\n");
      break;
    case "human": {
      const output = result.format();
      if (output) {
        process.stdout.write(output.endsWith("\n") ? output : output + "\n");
      }
      break;
    }
    case "quiet":
      // No output
      break;
    default: {
      const _exhaustive: never = mode;
      throw new Error(`Unknown output mode: ${String(_exhaustive)}`);
    }
  }
}
