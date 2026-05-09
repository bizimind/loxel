import type { ExecOptions, RunContainerOptions, SpawnOptions } from "../provider.ts";

/** Build the common CLI args from RunContainerOptions. Shared by all providers. */
export function buildRunArgs(bin: string, options: RunContainerOptions): string[] {
  const args = [bin, "run"];

  if (options.detach) args.push("-d");
  if (options.autoRemove) args.push("--rm");
  if (options.name) args.push("--name", options.name);
  if (options.workdir) args.push("-w", options.workdir);
  if (options.user) args.push("-u", options.user);
  if (options.hostname) args.push("--hostname", options.hostname);
  if (options.network) args.push("--network", options.network);

  if (options.env) {
    for (const [key, value] of Object.entries(options.env)) {
      args.push("-e", `${key}=${value}`);
    }
  }

  if (options.labels) {
    for (const [key, value] of Object.entries(options.labels)) {
      args.push("--label", `${key}=${value}`);
    }
  }

  if (options.resources?.cpus !== undefined) {
    args.push("--cpus", String(options.resources.cpus));
  }
  if (options.resources?.memory !== undefined) {
    args.push("--memory", options.resources.memory);
  }

  if (options.volumes) {
    for (const vol of options.volumes) {
      const mount = `${vol.host}:${vol.container}${vol.readonly ? ":ro" : ""}`;
      args.push("-v", mount);
    }
  }

  if (options.ports) {
    for (const port of options.ports) {
      const proto = port.protocol ?? "tcp";
      args.push("-p", `${port.host}:${port.container}/${proto}`);
    }
  }

  if (options.extraArgs) args.push(...options.extraArgs);

  args.push(options.image);

  if (options.command) args.push(...options.command);

  return args;
}

/** Build common exec args. Shared by all providers. */
export function buildExecArgs(
  bin: string,
  nameOrId: string,
  command: string[],
  options?: ExecOptions,
): string[] {
  const args = [bin, "exec"];

  if (options?.workdir) args.push("-w", options.workdir);
  if (options?.user) args.push("-u", options.user);
  if (options?.env) {
    for (const [key, value] of Object.entries(options.env)) {
      args.push("-e", `${key}=${value}`);
    }
  }

  args.push(nameOrId, ...command);
  return args;
}

/** Build streaming exec args (adds -i, and optionally -t for TTY). */
export function buildSpawnArgs(
  bin: string,
  nameOrId: string,
  command: string[],
  options?: SpawnOptions,
): string[] {
  const args = [bin, "exec", "-i"];

  if (options?.tty) args.push("-t");
  if (options?.workdir) args.push("-w", options.workdir);
  if (options?.user) args.push("-u", options.user);
  if (options?.env) {
    for (const [key, value] of Object.entries(options.env)) {
      args.push("-e", `${key}=${value}`);
    }
  }

  args.push(nameOrId, ...command);
  return args;
}

/**
 * Normalize raw container state strings to a canonical set.
 *
 * Tolerates:
 * - Docker `inspect.State.Status`: "running" | "exited" | "created" | "paused" | "dead" | "restarting"
 * - Docker `ps --format json`: same enum in `State`, human string in `Status` ("Up 3 minutes")
 * - Podman `ps --format json`: only human `Status` ("Up 3 minutes", "Exited (0) 2 hours ago")
 * - Apple `container list`: "running" | "stopped" | etc.
 */
export function normalizeState(
  state: string,
): "created" | "running" | "paused" | "stopped" | "dead" | "unknown" {
  const lower = state.toLowerCase();
  if (lower === "running" || lower.startsWith("up ")) return "running";
  if (lower === "created") return "created";
  if (lower === "paused") return "paused";
  if (lower === "dead") return "dead";
  // Docker: "exited". Podman human: "exited (N) ago". Unify to "stopped".
  if (lower === "exited" || lower === "stopped" || lower.startsWith("exited")) return "stopped";
  if (lower.startsWith("restarting")) return "running";
  return "unknown";
}
