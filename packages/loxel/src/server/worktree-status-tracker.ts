import type { StatusInfo, WorktreeEntry, WorktreeStatusInfo } from "@/api/git-models";

import { readWorktreeStatuses, toDirtyWorktreeStatus } from "./git-commands";
import { logger } from "./logger";

const log = logger.child("worktrees");

/** Coalesces the burst of project events one git operation produces (log, refs, status). */
const URGENT_SWEEP_DELAY_MS = 250;
/**
 * Minimum spacing of sweeps triggered only by activity in a subscribed worktree. Such activity
 * says nothing about the other worktrees; the sweep it triggers is just the only refresh an
 * unwatched worktree gets, so it is rate-limited instead of running after every edit.
 */
const ACTIVITY_SWEEP_INTERVAL_MS = 5_000;
/**
 * How old a sweep may be and still answer an explicit request (a client loading the list).
 * Unwatched worktrees change without any event, so a request re-reads unless a sweep just ran —
 * which keeps concurrent loads from multiplying sweeps without serving old data to a new window.
 */
const REQUEST_MAX_AGE_MS = 2_000;

interface TrackedWorktree {
  worktree: Pick<WorktreeEntry, "path" | "isMain">;
  /** Dirty summary, or null when clean. */
  status: WorktreeStatusInfo | null;
}

export interface WorktreeStatusTrackerOptions {
  projectPath: string;
  /** A status kept current by a subscribed worktree's watchers; such worktrees skip git. */
  liveStatus: (worktreePath: string) => StatusInfo | undefined;
  /** Whether any client listens to this project; unobserved sweeps wait until asked for. */
  hasListeners: () => boolean;
  /** Receives the dirty-worktree list whenever it changes. */
  onChange: (statuses: WorktreeStatusInfo[]) => void;
  /** Injectable for tests. */
  readStatuses?: typeof readWorktreeStatuses;
  urgentDelayMs?: number;
  activityIntervalMs?: number;
  requestMaxAgeMs?: number;
}

/**
 * The dirty-status list for every worktree of one project (the cross-worktree indicators and
 * the git graph's "uncommitted changes" rows), cached server-side.
 *
 * Only subscribed worktrees have watchers. Their status arrives through {@link update} from the
 * snapshot their file service already read, so it costs no git process and reaches clients
 * immediately. Every other worktree can only be refreshed by a sweep that runs `git status` in
 * each of them, which is:
 *
 * - run soon after {@link invalidate} — git metadata changed (commit, checkout, worktree
 *   add/remove), which is when another worktree's status most likely changed;
 * - rate-limited to once per {@link ACTIVITY_SWEEP_INTERVAL_MS} when triggered only by activity
 *   in a subscribed worktree;
 * - single-flight: concurrent requests share the running sweep, and a request that needs newer
 *   data than the running sweep can give queues exactly one follow-up.
 */
export class WorktreeStatusTracker {
  /** Worktrees in `git worktree list` order. Empty until the first sweep. */
  private entries = new Map<string, TrackedWorktree>();
  /** Bumped by invalidate(); a sweep is fresh only if nothing invalidated it after it began. */
  private generation = 0;
  /** Generation the cached entries reflect; -1 before the first sweep. */
  private sweptGeneration = -1;
  private inFlight: { generation: number; promise: Promise<void> } | null = null;
  private queued: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerDueAt = 0;
  private lastSweepStartedAt = Number.NEGATIVE_INFINITY;
  private lastSweepFinishedAt = Number.NEGATIVE_INFINITY;
  /** When activity last asked for a sweep; one that began before it does not cover it. */
  private lastActivityAt = Number.NEGATIVE_INFINITY;
  private lastPublished: string | null = null;
  private disposed = false;

  private readonly readStatuses: typeof readWorktreeStatuses;
  private readonly urgentDelayMs: number;
  private readonly activityIntervalMs: number;
  private readonly requestMaxAgeMs: number;

  constructor(private readonly options: WorktreeStatusTrackerOptions) {
    this.readStatuses = options.readStatuses ?? readWorktreeStatuses;
    this.urgentDelayMs = options.urgentDelayMs ?? URGENT_SWEEP_DELAY_MS;
    this.activityIntervalMs = options.activityIntervalMs ?? ACTIVITY_SWEEP_INTERVAL_MS;
    this.requestMaxAgeMs = options.requestMaxAgeMs ?? REQUEST_MAX_AGE_MS;
  }

  /** The current list, sweeping first unless a sweep that is still valid finished just now. */
  async get(): Promise<WorktreeStatusInfo[]> {
    const fresh =
      this.sweptGeneration === this.generation &&
      Date.now() - this.lastSweepFinishedAt <= this.requestMaxAgeMs;
    if (!fresh) await this.sweep();
    return this.list();
  }

  /** A subscribed worktree read a fresh status: apply it now, refresh the rest in due course. */
  update(worktreePath: string, status: StatusInfo): void {
    if (this.disposed) return;
    const entry = this.entries.get(worktreePath);
    if (!entry) {
      // Not in the last worktree list: none read yet, or this worktree is new (whose add also
      // fires a `worktrees` event). Once a list exists, a path that never matches it must not
      // turn every save into an urgent sweep.
      if (this.sweptGeneration === -1) this.invalidate();
      else this.scheduleActivitySweep();
      return;
    }
    entry.status = toDirtyWorktreeStatus(entry.worktree, status);
    this.publish();
    this.scheduleActivitySweep();
  }

  /** Git metadata changed; any worktree's status may have. */
  invalidate(): void {
    if (this.disposed) return;
    this.generation++;
    this.schedule(this.urgentDelayMs);
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
  }

  private list(): WorktreeStatusInfo[] {
    const statuses: WorktreeStatusInfo[] = [];
    for (const { status } of this.entries.values()) {
      if (status) statuses.push(status);
    }
    return statuses;
  }

  /**
   * Schedule the rate-limited sweep that follows activity. Spaced from the end of the last sweep,
   * not its start: a sweep slower than the interval would otherwise run back to back.
   */
  private scheduleActivitySweep(): void {
    this.lastActivityAt = Date.now();
    const readyAt =
      Math.max(this.lastSweepStartedAt, this.lastSweepFinishedAt) + this.activityIntervalMs;
    this.schedule(Math.max(this.urgentDelayMs, readyAt - Date.now()));
  }

  /** Run a sweep after `delayMs`, unless one is already due sooner. Skipped while unobserved. */
  private schedule(delayMs: number): void {
    if (!this.options.hasListeners()) return;
    const dueAt = Date.now() + delayMs;
    if (this.timer && this.timerDueAt <= dueAt) return;
    this.clearTimer();
    this.timerDueAt = dueAt;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.sweep().catch((err: unknown) => {
        log.error("Failed to refresh dirty worktree statuses", {
          error: err,
          projectPath: this.options.projectPath,
        });
      });
    }, delayMs);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * Sweep now. A running sweep that began at the current generation is shared; one that began
   * before an invalidation gets exactly one queued follow-up, shared by every such caller.
   */
  private sweep(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.inFlight) {
      if (this.inFlight.generation === this.generation) return this.inFlight.promise;
      const next = () => {
        this.queued = null;
        return this.sweep();
      };
      this.queued ??= this.inFlight.promise.then(next, next);
      return this.queued;
    }

    this.clearTimer();
    const startedAt = Date.now();
    this.lastSweepStartedAt = startedAt;
    const generation = this.generation;
    const promise = this.runSweep(generation).finally(() => {
      this.inFlight = null;
      // Activity during a long sweep may have armed a timer that fired mid-sweep and joined it;
      // that sweep began too early to cover the activity, so schedule the one it asked for.
      if (!this.disposed && this.lastActivityAt > startedAt) this.scheduleActivitySweep();
    });
    this.inFlight = { generation, promise };
    return promise;
  }

  private async runSweep(generation: number): Promise<void> {
    const { liveStatus } = this.options;
    const probes = await this.readStatuses(this.options.projectPath, { liveStatus });
    if (this.disposed) return;

    const next = new Map<string, TrackedWorktree>();
    for (const { worktree, status } of probes) {
      // Re-read live snapshots at merge time: update() may have delivered a newer one while
      // the sweep ran. A status that could not be read keeps its last known value rather than
      // turning a dirty worktree clean.
      const live = liveStatus(worktree.path);
      let resolved: WorktreeStatusInfo | null;
      if (live) resolved = toDirtyWorktreeStatus(worktree, live);
      else if (status === undefined) resolved = this.entries.get(worktree.path)?.status ?? null;
      else resolved = status;
      next.set(worktree.path, { worktree, status: resolved });
    }
    this.entries = next;
    this.sweptGeneration = generation;
    this.lastSweepFinishedAt = Date.now();
    this.publish();
  }

  /** Notify listeners if the list differs from the last one published. */
  private publish(): void {
    const statuses = this.list();
    const serialized = JSON.stringify(statuses);
    if (serialized === this.lastPublished) return;
    this.lastPublished = serialized;
    this.options.onChange(statuses);
  }
}
