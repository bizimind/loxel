import type { Subprocess } from "bun";

import { isRecord } from "@/lib/is-record";

import {
  FORMAT_REJECTED,
  type FormatterBackend,
  type FormatterResult,
  idleTimer,
  killProcessGroup,
} from "./formatter-backends";
import { findProjectPackage, projectToolPath } from "./js-formatter";
import { logger } from "./logger";
import { getNodeEnv } from "./node-env";
import { isRepoTrusted } from "./repo-trust";
import { buildSpawnEnv } from "./shell-env";
import { measureSpawn } from "./spawn-metrics";

const log = logger.child("format");

const FORMAT_TIMEOUT_MS = 5_000;

/**
 * Runs in the worktree's Node, from `/` so that a version manager's shim for `node` reads no pin
 * file of the project, then moves into the project, as prettier finds a config's plugins from the
 * working directory. `.editorconfig` too, as the prettier CLI does (the library's default is to
 * ignore it). Uncached: prettier never notices config edits, and the editor follows them right away.
 */
const HOST_SOURCE = `
const prettier = require(process.argv[1]);
process.chdir(process.argv[2]);
process.on("disconnect", () => process.exit(0));
process.on("message", async ({ id, content, filePath }) => {
  try {
    const config = (await prettier.resolveConfig(filePath, { editorconfig: true, useCache: false })) ?? {};
    process.send({ id, formatted: await prettier.format(content, { ...config, filepath: filePath }) });
  } catch (err) {
    process.send({ id, error: err instanceof Error ? err.message : String(err) });
  }
});
`;

interface PendingRequest {
  resolve: (result: FormatterResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Formats with a project's own prettier through its library API, in a Node process of its own: it
 * loads the project's code and config, which a server could not unload when the repository stops
 * being trusted. It stays running for speed, as starting prettier per save costs about 200 ms.
 */
export class PrettierLibBackend implements FormatterBackend {
  private proc: Subprocess | null = null;
  private starting: Promise<Subprocess | null> | null = null;
  private pending = new Map<number, PendingRequest>();
  private requestId = 0;
  private dead = false;
  private readonly idle = idleTimer(
    () => this.pending.size > 0,
    () => this.destroy(),
  );

  /**
   * `dir` is the directory that selected prettier, and the search for its install starts at
   * `toolDir`, both in the worktree `wtPath`.
   */
  constructor(
    private readonly dir: string,
    private readonly toolDir: string,
    private readonly wtPath: string,
  ) {}

  async format(content: string, filePath: string): Promise<FormatterResult> {
    this.starting ??= this.start();
    const proc = await this.starting;
    if (!proc || this.dead) return null;
    this.idle.touch();
    return new Promise((resolve) => {
      const id = ++this.requestId;
      const timer = setTimeout(() => {
        log.warn("Prettier timed out", { filePath });
        this.settle(id, null);
      }, FORMAT_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
      try {
        proc.send({ id, content, filePath });
      } catch (err) {
        log.warn("Could not reach the prettier process", { filePath, error: err });
        this.settle(id, null);
      }
    });
  }

  isAlive(): boolean {
    return !this.dead;
  }

  destroy(): void {
    this.dead = true;
    this.idle.clear();
    this.settleAll();
    if (this.proc) killProcessGroup(this.proc.pid);
    this.proc = null;
  }

  private async start(): Promise<Subprocess | null> {
    const packageDir = findProjectPackage("prettier", this.toolDir, this.wtPath);
    const nodePath = (await getNodeEnv(this.wtPath)).env?.nodePath;
    const PATH = await projectToolPath(this.toolDir, this.wtPath);
    // Asked again here: nothing else separates the save's detection from this spawn.
    if (!packageDir || !nodePath || this.dead || !isRepoTrusted(this.wtPath)) {
      this.dead = true;
      return null;
    }
    try {
      const proc = measureSpawn("prettier", () =>
        Bun.spawn([nodePath, "-e", HOST_SOURCE, packageDir, this.workingDir()], {
          cwd: "/",
          env: { ...buildSpawnEnv(), PATH, MISE_NOT_FOUND_AUTO_INSTALL: "0" },
          stdin: "ignore",
          // A project's config may print; replies have their own channel.
          stdout: "ignore",
          // Waiting on a pipe here would let a child of the project's code hold up exit detection.
          stderr: "inherit",
          detached: true,
          serialization: "json",
          ipc: (reply: unknown) => this.handleReply(reply),
        }),
      );
      this.proc = proc;
      void this.watchExit(proc);
      log.info("Started prettier process", { dir: this.dir });
      return proc;
    } catch (err) {
      log.warn("Could not start the prettier process", { dir: this.dir, error: err });
      this.dead = true;
      return null;
    }
  }

  /** Both are ancestors of the saved file, and a config's plugins resolve from the nearer one. */
  private workingDir(): string {
    return this.toolDir.length > this.dir.length ? this.toolDir : this.dir;
  }

  private async watchExit(proc: Subprocess): Promise<void> {
    const code = await proc.exited;
    if (this.proc !== proc) return;
    log.warn("Prettier process exited", { dir: this.dir, code });
    this.dead = true;
    this.proc = null;
    this.settleAll();
  }

  private handleReply(reply: unknown): void {
    if (!isRecord(reply) || typeof reply.id !== "number") return;
    if (typeof reply.formatted === "string") {
      this.settle(reply.id, reply.formatted);
      return;
    }
    // Typically a syntax error in the buffer; the process is fine and the CLI would fail the same.
    log.warn("Prettier format failed", { dir: this.dir, error: reply.error });
    this.settle(reply.id, FORMAT_REJECTED);
  }

  private settle(id: number, result: FormatterResult): void {
    const request = this.pending.get(id);
    if (!request) return;
    clearTimeout(request.timer);
    this.pending.delete(id);
    request.resolve(result);
  }

  private settleAll(): void {
    for (const id of [...this.pending.keys()]) this.settle(id, null);
  }
}
