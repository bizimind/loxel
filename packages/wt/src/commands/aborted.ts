import {
  createResult,
  runAction,
  type CommandResult,
  type OutputContext,
  type RunOptions,
} from "@bizimind/cli-common";

import { PromptCancelled } from "../prompt.ts";

/** Result shape for a command the user cancelled at a prompt. */
export interface AbortedResult {
  aborted: true;
  reason: string;
}

export function abortedResult(reason: string): CommandResult<AbortedResult> {
  return createResult<AbortedResult>({ aborted: true, reason }, () => "Aborted.");
}

/**
 * `runAction` for commands that may prompt: leaving a prompt with Ctrl+C is a
 * cancellation, reported exactly like choosing "Cancel" (exit 0, `aborted`).
 */
export function runCommand<T>(
  options: RunOptions,
  action: (ctx: OutputContext) => Promise<CommandResult<T | AbortedResult>>,
): Promise<void> {
  return runAction<T | AbortedResult>(options, async (ctx) => {
    try {
      return await action(ctx);
    } catch (err) {
      if (err instanceof PromptCancelled) return abortedResult(err.message);
      throw err;
    }
  });
}
