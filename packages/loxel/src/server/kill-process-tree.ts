import { logger } from "./logger";

const log = logger.child("server");

/** How many times to look for processes started while the ones found so far were being frozen. */
const MAX_FREEZE_ROUNDS = 5;

/** Each process's children, from the system's `ps` whatever `PATH` holds. */
function listChildren(): Map<number, number[]> {
  const children = new Map<number, number[]>();
  const { stdout, success } = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid="], {
    env: { PATH: "/bin:/usr/bin" },
    stdin: "ignore",
    stderr: "ignore",
  });
  if (!success) return children;
  for (const line of stdout.toString().split("\n")) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (child === undefined || parent === undefined) continue;
    children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  return children;
}

function descendantsOf(roots: readonly number[]): number[] {
  const children = listChildren();
  const found: number[] = [];
  const queue = [...roots];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    for (const child of children.get(next) ?? []) {
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

function signalIfAlive(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
}

/**
 * End each process in `roots` and everything below it, whatever process groups they are in and
 * whether or not a root's parent is still there. Every process is frozen before any is killed: a
 * killed parent's children could no longer be found below it, and a frozen one starts nothing new.
 *
 * Call it while a root is alive. A process that has already left its tree, by daemonizing or because
 * its parent ended earlier, cannot be found. A root's number must still be its own, since an ended
 * process's number can be reused. Without a `ps` it ends only the roots. It blocks for each `ps`, a
 * few milliseconds.
 */
export function killProcessTrees(roots: readonly number[]): void {
  const frozen = new Set<number>(roots);
  for (const root of roots) signalIfAlive(root, "SIGSTOP");
  try {
    for (let round = 0; round < MAX_FREEZE_ROUNDS; round++) {
      const fresh = descendantsOf(roots).filter((pid) => !frozen.has(pid));
      if (fresh.length === 0) break;
      for (const pid of fresh) {
        signalIfAlive(pid, "SIGSTOP");
        frozen.add(pid);
      }
    }
  } catch (err) {
    log.warn("Could not list a process tree", { error: err });
  }
  for (const pid of frozen) signalIfAlive(pid, "SIGKILL");
}
