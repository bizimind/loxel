/**
 * What the update UI says about the terminals an update restarts: the warning in the top bar and
 * Settings > General, and the confirmation before Install & Restart. See docs/ELECTRON.md#updates.
 */
import type { RunningTerminal } from "@/api/running-terminals-model";
import type { RestartsTerminals, UpdateState } from "@/api/update-model";

function terminals(count: number): string {
  return count === 1 ? "1 terminal" : `${count} terminals`;
}

/** Whether the update `status` is about restarts the terminals; false when there is none. */
export function restartsTerminalsOf(status: UpdateState | undefined): RestartsTerminals {
  if (
    status?.state === "available" ||
    status?.state === "downloading" ||
    status?.state === "ready"
  ) {
    return status.restartsTerminals;
  }
  return false;
}

/** The warning for an update, or null when it restarts no terminal. */
export function terminalRestartWarning(
  restartsTerminals: RestartsTerminals,
  terminalCount: number,
): string | null {
  if (restartsTerminals === false || terminalCount === 0) return null;
  return restartsTerminals === true
    ? `This update restarts ${terminals(terminalCount)}`
    : `This update may restart ${terminals(terminalCount)}`;
}

/** A terminal with a program running, as the confirmation lists it. */
export interface BusyTerminal {
  id: string;
  program: string;
  /** The worktree's folder name. */
  worktree: string;
}

export interface TerminalRestartConfirmation {
  title: string;
  message: string;
  /**
   * The terminals with a program running, where their terminal host can tell (capability
   * `foregroundProcess`). A terminal whose host cannot is counted in `message` only.
   */
  busy: BusyTerminal[];
}

/** What to ask before installing `version`, or null when it restarts no terminal. */
export function terminalRestartConfirmation(
  version: string,
  restartsTerminals: RestartsTerminals,
  running: readonly RunningTerminal[],
): TerminalRestartConfirmation | null {
  if (restartsTerminals === false || running.length === 0) return null;
  const busy = running.flatMap((terminal) =>
    typeof terminal.program === "string"
      ? [
          {
            id: terminal.id,
            program: terminal.program,
            // A Home terminal's has none.
            worktree: terminal.worktreePath === null ? "Home" : folderName(terminal.worktreePath),
          },
        ]
      : [],
  );
  const them = running.length === 1 ? "it" : `all ${running.length}`;
  return {
    title: terminalRestartWarning(restartsTerminals, running.length) ?? "",
    message:
      restartsTerminals === true
        ? `Version ${version} cannot take over the terminals running now, so installing it ends ${them}.`
        : `Version ${version} does not say whether it can take over the terminals running now. If it cannot, installing it ends ${them}.`,
    busy,
  };
}

function folderName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}
