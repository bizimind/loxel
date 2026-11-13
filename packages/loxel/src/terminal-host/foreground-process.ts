/**
 * Which program is in the foreground of a session's terminal: the PTY's foreground process group,
 * as `ps` reports it (`tpgid`), named by its leader. A shell at its prompt is its own foreground
 * group; a program it runs as a job gets a group of its own. The host reports it for capability
 * `foregroundProcess`. See docs/TERMINAL_HOST.md#capabilities.
 */
import { basename } from "node:path";

import { $ } from "bun";

/** A session's leader: the program the session spawned, by pid and by the name it started as. */
export interface SessionLeader {
  pid: number;
  /** `argv[0]` of the spawn. */
  program: string;
}

/**
 * The foreground program of each session whose leader is in `leaders`, by leader pid: its name,
 * or null when the leader itself, as spawned, is in the foreground (a shell at its prompt). A
 * leader that `exec`'d another program counts as that program. A terminal whose foreground
 * program cannot be named (its terminal or the group's leader already gone) is left out.
 */
export async function foregroundPrograms(
  leaders: readonly SessionLeader[],
): Promise<Map<number, string | null>> {
  const programs = new Map<number, string | null>();
  if (leaders.length === 0) return programs;
  const rows = await ps(leaders.map((leader) => leader.pid));
  const foreground = new Map<number, number>();
  for (const { pid, program } of leaders) {
    const row = rows.get(pid);
    // Gone, or its terminal has no foreground group.
    if (!row || row.tpgid <= 0) continue;
    if (row.tpgid !== pid) {
      foreground.set(pid, row.tpgid);
      continue;
    }
    const name = programName(row.command);
    programs.set(pid, name === programName(program) ? null : name);
  }
  if (foreground.size === 0) return programs;
  const groups = await ps([...new Set(foreground.values())]);
  for (const [leader, group] of foreground) {
    const command = groups.get(group)?.command;
    // The group's leader already exited (a pipeline's first process, say): a program runs, but
    // which one is not known.
    if (command !== undefined) programs.set(leader, programName(command));
  }
  return programs;
}

interface PsRow {
  tpgid: number;
  command: string;
}

/**
 * `ps` of `pids`: each one's terminal's foreground group and its command. `ps` exits non-zero when
 * one of them is gone, which is not an error here.
 */
async function ps(pids: readonly number[]): Promise<Map<number, PsRow>> {
  const output = await $`/bin/ps -o pid= -o tpgid= -o comm= -p ${pids.join(",")}`
    .nothrow()
    .quiet()
    .text();
  const rows = new Map<number, PsRow>();
  for (const line of output.split("\n")) {
    // The command is last, and may contain spaces (a path).
    const match = /^\s*(\d+)\s+(-?\d+)\s+(.+?)\s*$/.exec(line);
    if (match) rows.set(Number(match[1]), { tpgid: Number(match[2]), command: match[3]! });
  }
  return rows;
}

/** A command as `ps` names it (a path, or `-zsh` for a login shell) to the program's name. */
export function programName(command: string): string {
  return basename(command.replace(/^-/, ""));
}
