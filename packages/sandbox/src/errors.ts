export type SandboxErrorCode =
  | "not_found"
  | "destroyed"
  | "name_conflict"
  | "port_unmapped"
  | "provider_unavailable"
  | "unsupported"
  | "cli_failed"
  | "invalid_spec";

export interface SandboxErrorOptions {
  code: SandboxErrorCode;
  message?: string;
  provider?: string;
  cause?: unknown;
}

/**
 * Base error class for sandbox-related errors.
 * Always carries a `code` so callers can branch without relying on subclass checks.
 */
export class SandboxError extends Error {
  override readonly name: string = "SandboxError";
  readonly code: SandboxErrorCode;
  readonly provider?: string;

  constructor(options: SandboxErrorOptions) {
    super(options.message ?? options.code, { cause: options.cause });
    this.code = options.code;
    this.provider = options.provider;
  }
}

/** Thrown when no container runtime is found on the system. */
export class ProviderNotFoundError extends SandboxError {
  override readonly name: string = "ProviderNotFoundError";

  constructor(provider?: string) {
    super({
      code: "provider_unavailable",
      message: provider
        ? `Container runtime "${provider}" not found or not running`
        : "No container runtime found (tried: container, podman, docker)",
      provider,
    });
  }
}

/** Thrown when a container is not found by ID or name. */
export class ContainerNotFoundError extends SandboxError {
  override readonly name: string = "ContainerNotFoundError";
  readonly containerId: string;

  constructor(containerId: string, provider?: string, options?: { cause?: unknown }) {
    super({
      code: "not_found",
      message: `Container "${containerId}" not found`,
      provider,
      cause: options?.cause,
    });
    this.containerId = containerId;
  }
}

/** Thrown when a CLI command fails with a non-zero exit code. */
export class CliError extends SandboxError {
  override readonly name: string = "CliError";
  readonly command: string[];
  readonly exitCode: number;
  readonly stderr: string;

  constructor(args: {
    command: string[];
    exitCode: number;
    stderr: string;
    provider?: string;
    message?: string;
  }) {
    super({
      code: "cli_failed",
      message: args.message ?? `Command failed: ${args.command.join(" ")} (exit ${args.exitCode})`,
      provider: args.provider,
    });
    this.command = args.command;
    this.exitCode = args.exitCode;
    this.stderr = args.stderr;
  }
}
