import { z } from "zod";

import type { ContainerInfo } from "../container-info.ts";
import type { ExecHandle } from "../exec-handle.ts";
import type {
  ExecOptions,
  ExecResult,
  ListFilter,
  LogsOptions,
  RunContainerOptions,
  SandboxProvider,
  SpawnOptions,
} from "../provider.ts";

import {
  CliError,
  ContainerNotFoundError,
  ProviderNotFoundError,
  SandboxError,
} from "../errors.ts";
import { createExecHandle } from "../exec-handle.ts";
import { runCli, runCliJson, spawnCliStream } from "../exec.ts";
import { buildExecArgs, buildRunArgs, buildSpawnArgs, normalizeState } from "./provider-utils.ts";

// Apple's CLI JSON shape is still evolving. Parse defensively: everything
// optional, unknown keys preserved via `.passthrough()`.
//
// `container inspect` and `container list --format json` return the same
// object shape, so one schema + normalizer serves both. Observed layout:
//
//   {
//     "status": "running",
//     "networks": [{ "ipv4Address": "192.168.65.43/24", "network": "default", ... }],
//     "configuration": {
//       "id": "my-container",
//       "labels": { "k": "v" },
//       "image": { "reference": "docker.io/library/alpine:latest" }
//     }
//   }
//
// Older Apple CLI builds put `id`, `labels`, `image`, and a `networks[].address`
// field at the top level — the schema keeps those as optional fallbacks.
const AppleConfigurationSchema = z
  .object({
    id: z.string().optional(),
    image: z.object({ reference: z.string().optional() }).passthrough().optional(),
    labels: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

const AppleNetworkSchema = z
  .object({ ipv4Address: z.string().optional(), address: z.string().optional() })
  .passthrough();

const AppleEntrySchema = z
  .object({
    id: z.string().optional(),
    state: z.string().optional(),
    status: z.string().optional(),
    createdAt: z.string().optional(),
    image: z.unknown().optional(),
    labels: z.record(z.string(), z.string()).optional(),
    configuration: AppleConfigurationSchema.optional(),
    networks: z.array(AppleNetworkSchema).optional(),
  })
  .passthrough();

/**
 * Apple Containers provider — standalone implementation.
 * Reuses arg-building helpers from base-oci but implements its own
 * readiness, inspect/list normalization, and address resolution.
 *
 * Apple's CLI does not currently support `cp` or `--hostname`; those
 * methods throw `SandboxError({ code: "unsupported" })`.
 */
export class AppleContainerProvider implements SandboxProvider {
  readonly type = "apple" as const;
  private readonly bin = "container";

  async ensureReady(): Promise<void> {
    // `container system start` is idempotent — starts the launchd service if not running
    const result = await runCli([this.bin, "system", "start"], { throwOnError: false });
    if (result.exitCode !== 0) {
      throw new ProviderNotFoundError(this.type);
    }
  }

  async run(options: RunContainerOptions): Promise<string> {
    if (options.hostname) {
      throw new SandboxError({
        code: "unsupported",
        message: "Apple Containers does not support --hostname",
        provider: this.type,
      });
    }
    const args = buildRunArgs(this.bin, options);
    const result = await runCli(args);
    return result.stdout.trim();
  }

  async start(nameOrId: string): Promise<void> {
    await runCli([this.bin, "start", nameOrId]);
  }

  async stop(nameOrId: string, options?: { timeout?: number }): Promise<void> {
    const args = [this.bin, "stop"];
    if (options?.timeout !== undefined) args.push("--time", String(options.timeout));
    args.push(nameOrId);
    await runCli(args);
  }

  async restart(nameOrId: string, options?: { timeout?: number }): Promise<void> {
    await this.stop(nameOrId, options);
    await this.start(nameOrId);
  }

  async remove(nameOrId: string, options?: { force?: boolean }): Promise<void> {
    const args = [this.bin, "delete"];
    if (options?.force) args.push("--force");
    args.push(nameOrId);
    await runCli(args);
  }

  async exec(nameOrId: string, command: string[], options?: ExecOptions): Promise<ExecResult> {
    const args = buildExecArgs(this.bin, nameOrId, command, options);
    return runCli(args, { throwOnError: false });
  }

  spawn(nameOrId: string, command: string[], options?: SpawnOptions): ExecHandle {
    const args = buildSpawnArgs(this.bin, nameOrId, command, options);
    const proc = Bun.spawn(args, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    return createExecHandle(proc);
  }

  async logs(nameOrId: string, options?: LogsOptions): Promise<string> {
    const args = [this.bin, "logs"];
    if (options?.tail !== undefined) args.push("-n", String(options.tail));
    args.push(nameOrId);
    const result = await runCli(args);
    return result.stdout;
  }

  logsStream(nameOrId: string, options?: LogsOptions): ReadableStream<string> {
    const args = [this.bin, "logs", "--follow"];
    if (options?.tail !== undefined) args.push("-n", String(options.tail));
    args.push(nameOrId);
    return spawnCliStream(args, { signal: options?.signal });
  }

  async inspect(nameOrId: string): Promise<ContainerInfo> {
    let raw: unknown;
    try {
      raw = await runCliJson([this.bin, "inspect", nameOrId]);
    } catch (error) {
      if (error instanceof CliError) {
        throw new ContainerNotFoundError(nameOrId, this.type, { cause: error });
      }
      throw error;
    }

    if (!Array.isArray(raw) || !raw[0]) {
      throw new ContainerNotFoundError(nameOrId, this.type);
    }

    const parsed = AppleEntrySchema.safeParse(raw[0]);
    if (!parsed.success) {
      throw new SandboxError({
        code: "cli_failed",
        message: `Unable to parse Apple \`container inspect\` output: ${parsed.error.message}`,
        provider: this.type,
        cause: parsed.error,
      });
    }
    return this.normalizeEntry(parsed.data);
  }

  async list(options?: { all?: boolean; filter?: ListFilter }): Promise<ContainerInfo[]> {
    const args = [this.bin, "list", "--format", "json"];
    if (options?.all) args.push("--all");
    const result = await runCli(args, { throwOnError: false });
    if (!result.stdout.trim()) return [];

    const raw = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(raw)) return [];
    const infos = raw.flatMap((entry) => {
      const parsed = AppleEntrySchema.safeParse(entry);
      return parsed.success ? [this.normalizeEntry(parsed.data)] : [];
    });

    const filterLabels = options?.filter?.labels;
    if (!filterLabels) return infos;
    return infos.filter((info) =>
      Object.entries(filterLabels).every(([key, value]) => info.labels[key] === value),
    );
  }

  async pull(image: string): Promise<void> {
    await runCli([this.bin, "image", "pull", image]);
  }

  async imageExists(image: string): Promise<boolean> {
    const result = await runCli([this.bin, "image", "inspect", image], { throwOnError: false });
    return result.exitCode === 0;
  }

  async copyTo(): Promise<void> {
    throw new SandboxError({
      code: "unsupported",
      message: "Apple Containers does not support file copy",
      provider: this.type,
    });
  }

  async copyFrom(): Promise<void> {
    throw new SandboxError({
      code: "unsupported",
      message: "Apple Containers does not support file copy",
      provider: this.type,
    });
  }

  async resolveAddress(
    nameOrId: string,
    containerPort: number,
  ): Promise<{ host: string; port: number }> {
    // Apple Containers gives each container a dedicated IP — directly reachable from host
    const info = await this.inspect(nameOrId);
    if (!info.ip) {
      throw new SandboxError({
        code: "port_unmapped",
        message: `Container "${nameOrId}" has no IP address`,
        provider: this.type,
      });
    }
    return { host: info.ip, port: containerPort };
  }

  private normalizeEntry(raw: z.infer<typeof AppleEntrySchema>): ContainerInfo {
    const id = raw.configuration?.id ?? raw.id ?? "";
    const labels = raw.configuration?.labels ?? raw.labels ?? {};
    const imageRef = raw.configuration?.image?.reference;
    const imageFallback = typeof raw.image === "string" ? raw.image : "";
    const rawIp = raw.networks?.[0]?.ipv4Address ?? raw.networks?.[0]?.address;
    const ip = rawIp ? (rawIp.split("/")[0] ?? null) : null;

    return {
      id,
      name: id, // Apple uses id as name when no --name given
      image: imageRef ?? imageFallback,
      state: normalizeState(raw.status ?? raw.state ?? "unknown"),
      ip,
      labels,
      createdAt: raw.createdAt ?? "",
    };
  }
}
