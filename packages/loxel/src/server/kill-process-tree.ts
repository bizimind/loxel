import { logger } from "./logger";

const log = logger.child("server");

/** How many times to look for processes started while the ones found so far were being frozen. */
const MAX_FREEZE_ROUNDS = 5;

/** How often a {@link ProcessTreeRecord} looks at its root's tree again. */
const RECORD_INTERVAL_MS = 5000;

/** The system's `ps` whatever `PATH` holds: each process's number, parent, group, state and start. */
const PS_COMMAND = ["ps", "-A", "-o", "pid=,ppid=,pgid=,stat=,lstart="];
const PS_OPTIONS = { env: { PATH: "/bin:/usr/bin" }, stdin: "ignore", stderr: "ignore" } as const;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

interface ProcessEntry {
  parent: number;
  group: number;
  zombie: boolean;
  /** When it started, in seconds, which tells it from a later process given the same number. */
  started: number;
}

/** A `ps` start time (`Tue Nov  3 22:01:13 2026`, local time) in seconds, or NaN. */
function parseStart(lstart: string): number {
  const match = /^\w+\s+(\w+)\s+(\d+)\s+(\d+):(\d+):(\d+)\s+(\d+)$/.exec(lstart.trim());
  if (!match) return Number.NaN;
  const [, month = "", day, hours, minutes, seconds, year] = match;
  const fields = [year, day, hours, minutes, seconds].map(Number);
  const [y = 0, d = 0, h = 0, m = 0, sec = 0] = fields;
  return new Date(y, MONTHS.indexOf(month), d, h, m, sec).getTime() / 1000;
}

/**
 * Whether two `ps` start times are the same process's. Within a second: procps can work its start
 * times out from the uptime, which moves the second between runs.
 */
function sameStart(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1;
}

function parseProcesses(stdout: string): Map<number, ProcessEntry> {
  const processes = new Map<number, ProcessEntry>();
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S.*)$/.exec(line);
    if (!match) continue;
    const [, pid, parent, group, state = "", lstart = ""] = match;
    processes.set(Number(pid), {
      parent: Number(parent),
      group: Number(group),
      zombie: state.startsWith("Z"),
      started: parseStart(lstart),
    });
  }
  return processes;
}

function listProcesses(): Map<number, ProcessEntry> {
  const { stdout, success } = Bun.spawnSync(PS_COMMAND, PS_OPTIONS);
  return success ? parseProcesses(stdout.toString()) : new Map();
}

function descendantsOf(
  roots: readonly number[],
  processes: ReadonlyMap<number, ProcessEntry> = listProcesses(),
): number[] {
  const children = new Map<number, number[]>();
  for (const [pid, { parent }] of processes) {
    children.set(parent, [...(children.get(parent) ?? []), pid]);
  }
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
 * its parent ended earlier, cannot be found; for a root that may exit first, keep a
 * {@link ProcessTreeRecord}. A root's number must still be its own, since an ended process's number
 * can be reused. Without a `ps` it ends only the roots. It blocks for each `ps`, a few milliseconds.
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

/**
 * What a process has running below it, looked at again every few seconds while it runs, so that
 * what it leaves behind when it exits on its own can still be ended. Once it has gone, its children
 * have a new parent and nothing leads from it to them.
 *
 * Not ended: a process started since the last look, one that left the tree before it, and one that
 * has moved to another process group since, as one detaching to serve others does.
 */
export class ProcessTreeRecord {
  /** Each process below the root at the last look. */
  private recorded = new Map<number, Pick<ProcessEntry, "group" | "started">>();
  /** When the root started, so a later process given its number is not taken for it. */
  private rootStarted: number | null = null;
  private looking: Promise<void> | null = null;
  private disposed = false;
  private readonly timer: Timer;

  constructor(private readonly root: number) {
    this.timer = setInterval(() => void this.record(), RECORD_INTERVAL_MS);
    this.timer.unref();
  }

  /** Look at the root's tree again, or wait for the look under way. */
  record(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.looking ??= this.look().finally(() => {
      this.looking = null;
    });
    return this.looking;
  }

  /**
   * Stop looking, and end what was below the root at the last look and is still running in the same
   * process group, with everything below it now. Call it once the root has exited.
   */
  killSurvivors(): void {
    this.dispose();
    if (this.recorded.size === 0) return;
    const survivors = [...listProcesses()]
      .filter(([pid, now]) => {
        const then = this.recorded.get(pid);
        return (
          then && !now.zombie && now.group === then.group && sameStart(now.started, then.started)
        );
      })
      .map(([pid]) => pid);
    if (survivors.length > 0) killProcessTrees(survivors);
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.timer);
  }

  private async look(): Promise<void> {
    try {
      const ps = Bun.spawn(PS_COMMAND, { ...PS_OPTIONS, stdout: "pipe" });
      const stdout = await new Response(ps.stdout).text();
      if ((await ps.exited) !== 0 || this.disposed) return;
      const processes = parseProcesses(stdout);
      // Once the root has gone its children have moved, so keep what was found while it was there.
      const root = processes.get(this.root);
      if (!root || root.zombie) return;
      this.rootStarted ??= root.started;
      if (!sameStart(root.started, this.rootStarted)) return;
      const recorded = new Map<number, Pick<ProcessEntry, "group" | "started">>();
      for (const pid of descendantsOf([this.root], processes)) {
        const entry = processes.get(pid);
        if (entry) recorded.set(pid, { group: entry.group, started: entry.started });
      }
      this.recorded = recorded;
    } catch (err) {
      log.warn("Could not record a process tree", { error: err });
    }
  }
}
