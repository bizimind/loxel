/**
 * Command runner that enforces CommandResult return type
 * and handles json/human/quiet output modes.
 */

import {
  createOutputContext,
  getOutputMode,
  type OutputContext,
  type OutputMode,
} from "./output.ts";
import { errorResult, type CommandResult, type ErrorData } from "./result.ts";

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
    const result = thrownErrorResult(err);
    printResult(mode, result);
    process.exitCode = result.exitCode;
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
    const result = thrownErrorResult(err);
    printResult(mode, result);
    process.exitCode = result.exitCode;
  }
}

/**
 * Convert an error thrown by a command action into an error result.
 *
 * The error's `code` becomes the exit code only when it is a positive integer:
 * errors from Node APIs and libraries carry string codes ("ENOENT", "syntax"),
 * which are not exit statuses, and a 0 would report a failure as success.
 */
function thrownErrorResult(err: unknown): CommandResult<ErrorData> {
  const message = err instanceof Error ? err.message : String(err);
  const code = typeof err === "object" && err !== null && "code" in err ? err.code : undefined;
  const exitCode = typeof code === "number" && Number.isInteger(code) && code > 0 ? code : 1;
  return errorResult(message, exitCode);
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
