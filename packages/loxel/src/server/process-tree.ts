/** Questions about the processes running below a shell, answered by `ps`. */
import { basename } from "node:path";

/**
 * Whether `pid` has a descendant whose executable is called `name`, in `ps -A -o pid=,ppid=,comm=`
 * output. `comm` is the full path on macOS (it may hold spaces) and the bare name on Linux.
 */
export function psOutputHasDescendant(psOutput: string, pid: number, name: string): boolean {
  const children = new Map<number, Array<{ pid: number; command: string }>>();
  for (const line of psOutput.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match?.[1] || !match[2] || !match[3]) continue;
    const parent = Number(match[2]);
    const siblings = children.get(parent) ?? [];
    siblings.push({ pid: Number(match[1]), command: match[3].trim() });
    children.set(parent, siblings);
  }
  const pending = [pid];
  const seen = new Set(pending);
  for (const current of pending) {
    for (const child of children.get(current) ?? []) {
      if (basename(child.command) === name) return true;
      if (!seen.has(child.pid)) {
        seen.add(child.pid);
        pending.push(child.pid);
      }
    }
  }
  return false;
}

/** Whether a `wt` process runs below `pid`. False when `ps` cannot tell. */
export async function isWtRunningBelow(pid: number): Promise<boolean> {
  try {
    const result = await Bun.$`ps -A -o pid=,ppid=,comm=`.nothrow().quiet();
    return result.exitCode === 0 && psOutputHasDescendant(result.text(), pid, "wt");
  } catch {
    return false;
  }
}
