import { z } from "zod";

import type { ContainerInfo } from "../container-info.ts";
import type { ExecHandle } from "../exec-handle.ts";
import type {
  ExecOptions,
  ExecResult,
  ListFilter,
  LogsOptions,
  ProviderType,
  RunContainerOptions,
  SandboxProvider,
  SpawnOptions,
} from "../provider.ts";

import { CliError, ContainerNotFoundError, SandboxError } from "../errors.ts";
import { createExecHandle } from "../exec-handle.ts";
import { runCli, runCliJson, spawnCliStream } from "../exec.ts";
import { buildExecArgs, buildRunArgs, buildSpawnArgs, normalizeState } from "./provider-utils.ts";

// Docker/Podman `inspect` and `ps --format json` output shapes. Both runtimes
// follow the docker schema closely; unknown fields are preserved via
// `.passthrough()`. Labels can appear as a map (docker inspect, podman ps) or
// a comma-separated string (docker ps `Labels` field) — handled at normalize
// time via `toLabels()`.

const LabelsField = z.union([z.record(z.string(), z.string()), z.string()]).optional();

const NetworkInfoSchema = z.object({ IPAddress: z.string().optional() }).passthrough();

const OciInspectSchema = z
  .object({
    Id: z.string().optional(),
    Name: z.string().optional(),
    Created: z.string().optional(),
    State: z.object({ Status: z.string().optional() }).passthrough().optional(),
    Config: z
      .object({ Image: z.string().optional(), Labels: LabelsField })
      .passthrough()
      .optional(),
    NetworkSettings: z
      .object({ Networks: z.record(z.string(), NetworkInfoSchema).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

const OciListEntrySchema = z
  .object({
    ID: z.string().optional(),
    Id: z.string().optional(),
    Names: z.union([z.string(), z.array(z.string())]).optional(),
    Name: z.string().optional(),
    Image: z.string().optional(),
    State: z.string().optional(),
    Status: z.string().optional(),
    Labels: LabelsField,
    CreatedAt: z.string().optional(),
    Created: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

function toLabels(raw: z.infer<typeof LabelsField>): Record<string, string> {
  if (!raw) return {};
  if (typeof raw === "object") return { ...raw };
  // Comma-separated "k=v,k2=v2" (docker ps format).
  const out: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}

/**
 * Shared base for Docker and Podman providers.
 * These two runtimes share ~95% of their CLI syntax.
 * Subclasses override only what differs: readiness check and list output parsing.
 */
export abstract class BaseOciProvider implements SandboxProvider {
  abstract readonly type: ProviderType;
  abstract readonly bin: string;

  abstract ensureReady(): Promise<void>;
  abstract parseListOutput(stdout: string): unknown[];

  async run(options: RunContainerOptions): Promise<string> {
    const args = buildRunArgs(this.bin, options);
    const result = await runCli(args);
    return result.stdout.trim();
  }

  async start(nameOrId: string): Promise<void> {
    await runCli([this.bin, "start", nameOrId]);
  }

  async stop(nameOrId: string, options?: { timeout?: number }): Promise<void> {
    const args = [this.bin, "stop"];
    if (options?.timeout !== undefined) args.push("-t", String(options.timeout));
    args.push(nameOrId);
    await runCli(args);
  }

  async restart(nameOrId: string, options?: { timeout?: number }): Promise<void> {
    const args = [this.bin, "restart"];
    if (options?.timeout !== undefined) args.push("-t", String(options.timeout));
    args.push(nameOrId);
    await runCli(args);
  }

  async remove(nameOrId: string, options?: { force?: boolean }): Promise<void> {
    const args = [this.bin, "rm"];
    if (options?.force) args.push("-f");
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
    if (options?.tail !== undefined) args.push("--tail", String(options.tail));
    args.push(nameOrId);
    const result = await runCli(args);
    return result.stdout;
  }

  logsStream(nameOrId: string, options?: LogsOptions): ReadableStream<string> {
    const args = [this.bin, "logs", "-f"];
    if (options?.tail !== undefined) args.push("--tail", String(options.tail));
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

    const parsed = OciInspectSchema.safeParse(raw[0]);
    if (!parsed.success) {
      throw new SandboxError({
        code: "cli_failed",
        message: `Unable to parse \`${this.bin} inspect\` output: ${parsed.error.message}`,
        provider: this.type,
        cause: parsed.error,
      });
    }
    return this.normalizeInspect(parsed.data);
  }

  async list(options?: { all?: boolean; filter?: ListFilter }): Promise<ContainerInfo[]> {
    const args = [this.bin, "ps", "--format", "json"];
    if (options?.all) args.push("-a");
    if (options?.filter?.labels) {
      for (const [key, value] of Object.entries(options.filter.labels)) {
        args.push("--filter", `label=${key}=${value}`);
      }
    }
    const result = await runCli(args, { throwOnError: false });
    if (!result.stdout.trim()) return [];

    const entries = this.parseListOutput(result.stdout);
    return entries.flatMap((entry) => {
      const parsed = OciListEntrySchema.safeParse(entry);
      return parsed.success ? [this.normalizeListEntry(parsed.data)] : [];
    });
  }

  async pull(image: string): Promise<void> {
    await runCli([this.bin, "pull", image]);
  }

  async imageExists(image: string): Promise<boolean> {
    const result = await runCli([this.bin, "image", "inspect", image], { throwOnError: false });
    return result.exitCode === 0;
  }

  async copyTo(nameOrId: string, hostPath: string, containerPath: string): Promise<void> {
    await runCli([this.bin, "cp", hostPath, `${nameOrId}:${containerPath}`]);
  }

  async copyFrom(nameOrId: string, containerPath: string, hostPath: string): Promise<void> {
    await runCli([this.bin, "cp", `${nameOrId}:${containerPath}`, hostPath]);
  }

  async resolveAddress(
    nameOrId: string,
    containerPort: number,
  ): Promise<{ host: string; port: number }> {
    const result = await runCli([this.bin, "port", nameOrId, String(containerPort)], {
      throwOnError: false,
    });
    // Output format: "0.0.0.0:12345" or ":::12345"
    const line = result.stdout.trim().split("\n")[0] ?? "";
    const match = line.match(/:(\d+)$/);
    if (!match?.[1]) {
      throw new SandboxError({
        code: "port_unmapped",
        message: `Port ${containerPort} is not mapped on container "${nameOrId}"`,
        provider: this.type,
      });
    }
    return { host: "127.0.0.1", port: Number(match[1]) };
  }

  protected normalizeInspect(raw: z.infer<typeof OciInspectSchema>): ContainerInfo {
    const firstNetwork = raw.NetworkSettings?.Networks
      ? Object.values(raw.NetworkSettings.Networks)[0]
      : undefined;
    const ip = firstNetwork?.IPAddress ? firstNetwork.IPAddress : null;

    return {
      id: raw.Id ?? "",
      name: (raw.Name ?? "").replace(/^\//, ""),
      image: raw.Config?.Image ?? "",
      state: normalizeState(raw.State?.Status ?? "unknown"),
      ip,
      labels: toLabels(raw.Config?.Labels),
      createdAt: raw.Created ?? "",
    };
  }

  protected normalizeListEntry(raw: z.infer<typeof OciListEntrySchema>): ContainerInfo {
    const name = Array.isArray(raw.Names) ? (raw.Names[0] ?? "") : (raw.Names ?? raw.Name ?? "");
    const createdAt =
      raw.CreatedAt ?? (typeof raw.Created === "string" ? raw.Created : String(raw.Created ?? ""));
    return {
      id: raw.ID ?? raw.Id ?? "",
      name,
      image: raw.Image ?? "",
      state: normalizeState(raw.State ?? raw.Status ?? "unknown"),
      ip: null,
      labels: toLabels(raw.Labels),
      createdAt,
    };
  }
}
