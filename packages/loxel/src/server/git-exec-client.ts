// Main-thread side of the git exec worker: sends each request to `git-exec-worker.ts` and resolves
// its promise with that request's own result. See docs/GIT.md#git-exec-worker.
import { gitCommandLabel, type GitExecRequest, type GitExecResult } from "./git-commands/git-exec";
import { logger } from "./logger";

const log = logger.child("git");

export interface GitExecMessage {
  id: number;
  request: GitExecRequest;
}

export interface GitExecReply {
  id: number;
  result: GitExecResult;
}

interface PendingRequest {
  args: readonly string[];
  resolve: (result: GitExecResult) => void;
  reject: (error: Error) => void;
}

/** The global `Worker` type is the DOM's here, which lacks Bun's `ref` and `unref`. */
export type GitExecWorker = Worker & Pick<Bun.Worker, "ref" | "unref">;

interface WorkerState {
  worker: GitExecWorker;
  pending: Map<number, PendingRequest>;
}

/**
 * The worker's URL has to work unbundled (`src/server/*.ts`) and bundled, where `import.meta.url`
 * is the entry point's (`dist/server/index.js`, `$bunfs/root/...`). So this module and the worker
 * sit next to `index.ts`, and the path has no extension: it is `.ts` in source and `.js` in `dist`.
 */
export function createGitExecWorker(): GitExecWorker {
  return new Worker(new URL("./git-exec-worker", import.meta.url).href) as GitExecWorker;
}

/** Bun's message for a throw in a worker dumps source lines first, with `error: ...` near the end. */
function summarizeWorkerError(message: string): string {
  const lines = message.split("\n");
  return (lines.find((line) => line.startsWith("error:")) ?? lines[0] ?? message).trim();
}

/**
 * Owns one worker at a time. A worker that dies fails the requests it had in flight, since they may
 * or may not have run and a mutating command must not be repeated, and the next request starts a
 * new worker.
 */
export class GitExecClient {
  private current: WorkerState | null = null;
  private nextId = 1;

  constructor(private readonly createWorker: () => GitExecWorker = createGitExecWorker) {}

  exec(request: GitExecRequest): Promise<GitExecResult> {
    const { worker, pending } = this.current ?? this.start();
    const id = this.nextId++;
    return new Promise<GitExecResult>((resolve, reject) => {
      pending.set(id, { args: request.args, resolve, reject });
      // Hold the process open only while a result is owed, so idle scripts and tests can exit.
      worker.ref();
      const message: GitExecMessage = { id, request };
      worker.postMessage(message);
    });
  }

  /** Stop the worker. Requests in flight reject; a later `exec` would start a new worker. */
  stop(): void {
    if (this.current) this.retire(this.current, "the server is shutting down");
  }

  private start(): WorkerState {
    const worker = this.createWorker();
    const state: WorkerState = { worker, pending: new Map() };
    worker.addEventListener("message", (event: MessageEvent<GitExecReply>) => {
      this.settle(state, event.data);
    });
    worker.addEventListener("error", (event: ErrorEvent) => {
      log.error("Git exec worker failed", { error: event.message });
      this.retire(state, `it failed: ${summarizeWorkerError(event.message)}`);
    });
    worker.addEventListener("close", () => {
      if (this.current !== state) return;
      log.error("Git exec worker exited unexpectedly");
      this.retire(state, "it exited unexpectedly");
    });
    worker.unref();
    this.current = state;
    return state;
  }

  private settle(state: WorkerState, { id, result }: GitExecReply): void {
    const request = state.pending.get(id);
    if (!request) return;
    state.pending.delete(id);
    if (state.pending.size === 0) state.worker.unref();
    request.resolve(result);
  }

  private retire(state: WorkerState, reason: string): void {
    if (this.current === state) this.current = null;
    for (const { args, reject } of state.pending.values()) {
      reject(
        new Error(`Git exec worker stopped while running ${gitCommandLabel(args)}: ${reason}`),
      );
    }
    state.pending.clear();
    state.worker.terminate();
  }
}

export const gitExecClient = new GitExecClient();
