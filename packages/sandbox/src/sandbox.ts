import type { ContainerInfo } from "./container-info.ts";
import { CliError, ContainerNotFoundError, SandboxError } from "./errors.ts";
import type { ExecHandle } from "./exec-handle.ts";
import type {
  ExecOptions,
  ExecResult,
  LogsOptions,
  SandboxProvider,
  SpawnOptions,
} from "./provider.ts";

/** Patterns in CLI stderr that indicate the container no longer exists. */
const NOT_FOUND_PATTERNS = [
  "no such container",
  "not found",
  "no container with",
  "could not find",
  "does not exist",
];

/**
 * Check if an error indicates the container is already gone.
 *
 * `stop()` / `remove()` throw `CliError` (not `ContainerNotFoundError`) when
 * the container doesn't exist — `ContainerNotFoundError` is only produced by
 * `inspect()`. We match stderr content against known not-found messages.
 */
function isGone(error: unknown): boolean {
  if (error instanceof ContainerNotFoundError) return true;
  if (error instanceof CliError) {
    const lower = error.stderr.toLowerCase();
    return NOT_FOUND_PATTERNS.some((p) => lower.includes(p));
  }
  return false;
}

/**
 * A live sandbox container, created via `SandboxTemplate.create()` or bound
 * to an existing container via `SandboxTemplate.attach()` / `find()`.
 *
 * After `destroy()` the instance is unusable and all methods throw
 * `SandboxError({ code: "destroyed" })`. The `id` field stays populated
 * so callers can still log it.
 */
export class Sandbox {
  private destroyed = false;
  private destroyPromise?: Promise<void>;

  /** @internal — use `SandboxTemplate.create()` instead. */
  constructor(
    readonly id: string,
    readonly name: string,
    readonly provider: SandboxProvider,
  ) {}

  // --- Lifecycle ------------------------------------------------------------

  /** Start a stopped container. */
  async start(): Promise<void> {
    await this.provider.start(this.requireAlive());
  }

  /** Stop the running container. */
  async stop(options?: { timeout?: number }): Promise<void> {
    await this.provider.stop(this.requireAlive(), options);
  }

  /** Restart the container (stop + start). */
  async restart(options?: { timeout?: number }): Promise<void> {
    await this.provider.restart(this.requireAlive(), options);
  }

  /** Remove the container. Does not mark the sandbox as destroyed. */
  async remove(options?: { force?: boolean }): Promise<void> {
    await this.provider.remove(this.requireAlive(), options);
  }

  /**
   * Stop and remove the container. Idempotent — concurrent and repeat calls
   * share the same in-flight promise. After `destroy()` every other method
   * throws `SandboxError({ code: "destroyed" })`.
   */
  async destroy(): Promise<void> {
    this.destroyPromise ??= this.runDestroy();
    return this.destroyPromise;
  }

  private async runDestroy(): Promise<void> {
    try {
      try {
        await this.provider.stop(this.id, { timeout: 5 });
      } catch (error) {
        // Container may already be stopped — swallow only the CLI failure path.
        if (!isGone(error)) throw error;
      }
      try {
        await this.provider.remove(this.id, { force: true });
      } catch (error) {
        // Container may have been auto-removed.
        if (!isGone(error)) throw error;
      }
    } finally {
      this.destroyed = true;
    }
  }

  // --- Introspection --------------------------------------------------------

  /** Inspect the container, returning normalized info. */
  async inspect(): Promise<ContainerInfo> {
    return this.provider.inspect(this.requireAlive());
  }

  /** Whether the container is currently running. */
  async isRunning(): Promise<boolean> {
    const info = await this.inspect();
    return info.state === "running";
  }

  /** Container IP address, or `null` when none is assigned. */
  async ip(): Promise<string | null> {
    const info = await this.inspect();
    return info.ip ?? null;
  }

  /**
   * Resolve how to reach a container port from the host.
   * - Apple: container IP + same port.
   * - Docker/Podman: localhost + mapped host port.
   */
  async address(containerPort: number): Promise<{ host: string; port: number }> {
    return this.provider.resolveAddress(this.requireAlive(), containerPort);
  }

  // --- Exec -----------------------------------------------------------------

  /** Execute a command synchronously and collect its output. */
  async exec(command: string[], options?: ExecOptions): Promise<ExecResult> {
    return this.provider.exec(this.requireAlive(), command, options);
  }

  /**
   * Execute a command with streaming stdio. Returns a handle exposing
   * web-standard stdin/stdout/stderr streams plus a `kill()` method.
   *
   * `tty: true` is not supported on Apple Containers; the provider throws
   * `SandboxError({ code: "unsupported" })` in that case.
   */
  spawn(command: string[], options?: SpawnOptions): ExecHandle {
    return this.provider.spawn(this.requireAlive(), command, options);
  }

  // --- Logs -----------------------------------------------------------------

  /** Fetch container logs as a single string. */
  async logs(options?: LogsOptions): Promise<string> {
    return this.provider.logs(this.requireAlive(), options);
  }

  /** Stream container logs line by line. */
  logsStream(options?: LogsOptions): ReadableStream<string> {
    return this.provider.logsStream(this.requireAlive(), options);
  }

  // --- Files (docker / podman only) ----------------------------------------

  /** Copy a file/dir from the host into the container. Unsupported on Apple. */
  async copyTo(hostPath: string, containerPath: string): Promise<void> {
    await this.provider.copyTo(this.requireAlive(), hostPath, containerPath);
  }

  /** Copy a file/dir from the container out to the host. Unsupported on Apple. */
  async copyFrom(containerPath: string, hostPath: string): Promise<void> {
    await this.provider.copyFrom(this.requireAlive(), containerPath, hostPath);
  }

  private requireAlive(): string {
    if (this.destroyed) {
      throw new SandboxError({
        code: "destroyed",
        message: `Sandbox "${this.id}" has been destroyed`,
        provider: this.provider.type,
      });
    }
    return this.id;
  }
}
