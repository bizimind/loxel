/**
 * Which program is in the foreground of a session's terminal: the PTY's foreground process group,
 * as `ps` reports it (`tpgid`), named by its leader. A shell at its prompt is its own foreground
 * group; a program it runs as a job gets a group of its own. The host reports it for capability
 * `foregroundProcess`. See docs/TERMINAL_HOST.md#capabilities.
 */
import { basename } from "node:path";

import { $ } from "bun";

/**
 * The foreground program of each terminal whose session leader (the program the session spawned)
 * is in `leaders`, by leader pid: its name, or null when the leader itself is in the foreground.
 * A terminal whose foreground program cannot be named (its pid already gone) is left out.
 */
export async function foregroundPrograms(
  leaders: readonly number[],
): Promise<Map<number, string | null>> {
  const programs = new Map<number, string | null>();
  if (leaders.length === 0) return programs;
  const groups = parseColumns(await ps(leaders, "tpgid"));
  const foreground = new Map<number, number>();
  for (const [leader, tpgid] of groups) {
    const group = Number(tpgid);
    // No foreground group (the terminal is gone), or the session's own program at its prompt.
    if (!Number.isInteger(group) || group <= 0 || group === leader) programs.set(leader, null);
    else foreground.set(leader, group);
  }
  if (foreground.size === 0) return programs;
  const names = parseColumns(await ps([...new Set(foreground.values())], "comm"));
  for (const [leader, group] of foreground) {
    const command = names.get(group);
    // The group's leader already exited (a pipeline's first process, say): a program runs, but
    // which one is not known, so the terminal is left out.
    if (command !== undefined) programs.set(leader, programName(command));
  }
  return programs;
}

/** `ps` columns `pid` and `column` of `pids`. Exits non-zero when one of them is gone: not an error. */
function ps(pids: readonly number[], column: "tpgid" | "comm"): Promise<string> {
  return $`ps -o pid= -o ${`${column}=`} -p ${pids.join(",")}`.nothrow().quiet().text();
}

/** Lines of `<pid> <value>`, by pid; the value may contain spaces (a path). */
function parseColumns(output: string): Map<number, string> {
  const rows = new Map<number, string>();
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (match) rows.set(Number(match[1]), match[2]!);
  }
  return rows;
}

/** A command as `ps` names it (a path, or `-zsh` for a login shell) to the program's name. */
export function programName(command: string): string {
  return basename(command.replace(/^-/, ""));
}
