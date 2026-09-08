import { createResult, type CommandResult } from "@bizimind/cli-common";

/** Result shape for a command the user cancelled at a prompt. */
export interface AbortedResult {
  aborted: true;
  reason: string;
}

export function abortedResult(reason: string): CommandResult<AbortedResult> {
  return createResult<AbortedResult>({ aborted: true, reason }, () => "Aborted.");
}
