/**
 * The terminals with a program running, as the confirmations before an update install and a quit
 * list them. Relative imports: Electron main, whose build has no path aliases, builds them too.
 */
import { z } from "zod";

import type { RunningTerminal } from "../api/running-terminals-model";

export const BusyTerminalSchema = z.object({
  id: z.string(),
  /** The program in its foreground. */
  program: z.string(),
  /** The worktree's folder name, or "Home" for a Home terminal. */
  worktree: z.string(),
});
export type BusyTerminal = z.infer<typeof BusyTerminalSchema>;

/**
 * The terminals of `running` whose terminal host reports a program in their foreground (capability
 * `foregroundProcess`). A shell at its prompt is left out, and so is a terminal whose host cannot
 * tell: see {@link unknownTerminalCount}.
 */
export function busyTerminals(running: readonly RunningTerminal[]): BusyTerminal[] {
  return running.flatMap((terminal) =>
    typeof terminal.program === "string"
      ? [
          {
            id: terminal.id,
            program: terminal.program,
            worktree: terminal.worktreePath === null ? "Home" : folderName(terminal.worktreePath),
          },
        ]
      : [],
  );
}

/** How many terminals of `running` run in a terminal host that cannot tell their program. */
export function unknownTerminalCount(running: readonly RunningTerminal[]): number {
  return running.filter((terminal) => terminal.program === undefined).length;
}

/** "1 terminal", "3 terminals". */
export function terminalCount(count: number): string {
  return count === 1 ? "1 terminal" : `${count} terminals`;
}

function folderName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}
