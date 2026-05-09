import type { ContainerInfo } from "./container-info.ts";
import type { ExecHandle } from "./exec-handle.ts";
import type { Resources } from "./sandbox-spec.ts";

export type ProviderType = "apple" | "podman" | "docker";

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  workdir?: string;
  env?: Record<string, string>;
  user?: string;
}

export interface SpawnOptions extends ExecOptions {
  /** Allocate a TTY. Unsupported on Apple Containers. */
  tty?: boolean;
}

export interface LogsOptions {
  follow?: boolean;
  tail?: number;
  signal?: AbortSignal;
}

export interface ListFilter {
  /** Label key/value pairs — all must match (AND semantics). */
  labels?: Record<string, string>;
}

/** Low-level container run options — resolved from SandboxSpec by the template. */
export interface RunContainerOptions {
  image: string;
  name?: string;
  detach: boolean;
  command?: string[];
  env?: Record<string, string>;
  volumes?: Array<{ host: string; container: string; readonly?: boolean }>;
  ports?: Array<{ host: number; container: number; protocol?: string }>;
  workdir?: string;
  user?: string;
  hostname?: string;
  network?: string;
  labels?: Record<string, string>;
  resources?: Resources;
  autoRemove?: boolean;
  extraArgs?: string[];
}

export interface SandboxProvider {
  readonly type: ProviderType;

  /** Ensure the provider's daemon/service/VM is running. */
  ensureReady(): Promise<void>;

  /** Create and start a container. Returns container ID. */
  run(options: RunContainerOptions): Promise<string>;

  /** Start a stopped container. */
  start(nameOrId: string): Promise<void>;

  /** Stop a running container. */
  stop(nameOrId: string, options?: { timeout?: number }): Promise<void>;

  /** Restart a container (stop + start). */
  restart(nameOrId: string, options?: { timeout?: number }): Promise<void>;

  /** Remove a container. */
  remove(nameOrId: string, options?: { force?: boolean }): Promise<void>;

  /** Execute a command synchronously, collecting output. */
  exec(nameOrId: string, command: string[], options?: ExecOptions): Promise<ExecResult>;

  /** Execute a command with streaming stdio access. */
  spawn(nameOrId: string, command: string[], options?: SpawnOptions): ExecHandle;

  /** Get container logs as a string. */
  logs(nameOrId: string, options?: LogsOptions): Promise<string>;

  /** Stream container logs as a ReadableStream of lines. */
  logsStream(nameOrId: string, options?: LogsOptions): ReadableStream<string>;

  /** Inspect a container, returning normalized info. */
  inspect(nameOrId: string): Promise<ContainerInfo>;

  /**
   * List containers matching the given filter.
   * Label filters are ANDed together.
   */
  list(options?: { all?: boolean; filter?: ListFilter }): Promise<ContainerInfo[]>;

  /** Pull an image from a registry. */
  pull(image: string): Promise<void>;

  /** Check whether an image is present in the local image store. */
  imageExists(image: string): Promise<boolean>;

  /** Copy a file/dir from host into the container. */
  copyTo(nameOrId: string, hostPath: string, containerPath: string): Promise<void>;

  /** Copy a file/dir from the container out to the host. */
  copyFrom(nameOrId: string, containerPath: string, hostPath: string): Promise<void>;

  /**
   * Resolve how to reach a container's exposed port from the host.
   * - Apple Containers: container IP + port (direct network access).
   * - Docker/Podman on macOS: localhost + mapped host port.
   */
  resolveAddress(nameOrId: string, containerPort: number): Promise<{ host: string; port: number }>;
}
