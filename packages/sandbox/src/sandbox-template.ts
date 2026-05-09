import { randomBytes } from "node:crypto";

import type { ProviderType, SandboxProvider } from "./provider.ts";

import { createProvider } from "./create-provider.ts";
import { detectPreferredProvider } from "./detect.ts";
import { ContainerNotFoundError, ProviderNotFoundError, SandboxError } from "./errors.ts";
import { SandboxSpecSchema, type SandboxSpec, type SandboxSpecInput } from "./sandbox-spec.ts";
import { Sandbox } from "./sandbox.ts";

/** Label key every SDK-managed container receives. */
export const SDK_LABEL = "sandbox.sdk";
/** Value of the SDK baseline label. */
export const SDK_LABEL_VALUE = "bizimind";

export interface SandboxTemplateOptions {
  /** Inject a provider instance directly. */
  provider?: SandboxProvider;
  /** Specify provider type (auto-creates instance). Ignored if `provider` is set. */
  providerType?: ProviderType;
}

/** Generate a short random suffix for container names. */
function randomSuffix(): string {
  return randomBytes(4).toString("hex");
}

/**
 * A reusable spec + provider pair for creating sandbox containers.
 * The template is stateless with respect to running containers; live
 * instances are represented by `Sandbox`.
 */
export class SandboxTemplate {
  readonly spec: SandboxSpec;
  readonly provider: SandboxProvider;

  constructor(input: SandboxSpecInput, options?: SandboxTemplateOptions) {
    try {
      this.spec = SandboxSpecSchema.parse(input);
    } catch (error) {
      throw new SandboxError({
        code: "invalid_spec",
        message: error instanceof Error ? error.message : "Invalid sandbox spec",
        cause: error,
      });
    }

    if (options?.provider) {
      this.provider = options.provider;
      return;
    }
    const type = options?.providerType ?? detectPreferredProvider();
    if (!type) throw new ProviderNotFoundError();
    this.provider = createProvider(type);
  }

  /**
   * Create and start a sandbox container from this template.
   *
   * The container name is generated as `<spec.name>-<random>` unless an
   * explicit `name` override is provided.
   *
   * All overrides are merged shallowly into the spec, re-validated, and applied:
   * - `env`, `labels`: shallow-merged
   * - `volumes`, `ports`: appended
   * - other fields: replaced
   *
   * The baseline `sandbox.sdk=bizimind` label is always added.
   */
  async create(overrides?: Partial<SandboxSpecInput>): Promise<Sandbox> {
    const spec = this.mergeOverrides(overrides);

    // Auto-generate unique name when no explicit name override was provided
    const finalName = overrides?.name !== undefined ? spec.name : `${spec.name}-${randomSuffix()}`;

    await this.provider.ensureReady();
    await this.cleanupExisting(finalName);

    const labels = { ...spec.labels, [SDK_LABEL]: SDK_LABEL_VALUE };

    const containerId = await this.provider.run({
      image: spec.image,
      name: finalName,
      detach: true,
      command: spec.command,
      env: spec.env,
      volumes: spec.volumes,
      ports: spec.ports,
      workdir: spec.workdir,
      user: spec.user,
      hostname: spec.hostname,
      network: spec.network,
      labels,
      resources: spec.resources,
      autoRemove: spec.autoRemove,
      extraArgs: spec.providerArgs,
    });

    return new Sandbox(containerId, finalName, this.provider);
  }

  /**
   * Attach to an existing container by name or ID.
   * Verifies the container exists, then returns a `Sandbox` instance bound to it.
   * Throws `ContainerNotFoundError` if the container is absent.
   */
  async attach(nameOrId: string): Promise<Sandbox> {
    await this.provider.ensureReady();
    const info = await this.provider.inspect(nameOrId);
    return new Sandbox(info.id, info.name || nameOrId, this.provider);
  }

  /**
   * Find SDK-managed sandboxes matching the provided labels (ANDed).
   * The baseline `sandbox.sdk=bizimind` label is always applied, so only
   * containers created via this SDK are returned.
   */
  async find(filter?: { label?: Record<string, string> }): Promise<Sandbox[]> {
    await this.provider.ensureReady();
    const labels = { ...filter?.label, [SDK_LABEL]: SDK_LABEL_VALUE };
    const infos = await this.provider.list({ all: true, filter: { labels } });
    return infos.map((info) => new Sandbox(info.id, info.name, this.provider));
  }

  private mergeOverrides(overrides?: Partial<SandboxSpecInput>): SandboxSpec {
    if (!overrides) return this.spec;

    const merged: SandboxSpecInput = {
      ...this.spec,
      ...overrides,
      env: { ...this.spec.env, ...overrides.env },
      labels: { ...this.spec.labels, ...overrides.labels },
      volumes: [...this.spec.volumes, ...(overrides.volumes ?? [])],
      ports: [...this.spec.ports, ...(overrides.ports ?? [])],
      providerArgs: overrides.providerArgs ?? this.spec.providerArgs,
    };

    try {
      return SandboxSpecSchema.parse(merged);
    } catch (error) {
      throw new SandboxError({
        code: "invalid_spec",
        message: error instanceof Error ? error.message : "Invalid sandbox spec",
        cause: error,
      });
    }
  }

  private async cleanupExisting(name: string): Promise<void> {
    try {
      const info = await this.provider.inspect(name);
      if (info.state === "running") {
        throw new SandboxError({
          code: "name_conflict",
          message: `Container "${name}" is already running. Stop it first or use a different name.`,
          provider: this.provider.type,
        });
      }
      // Container exists but not running — remove it
      await this.provider.remove(name, { force: true });
    } catch (error) {
      if (error instanceof ContainerNotFoundError) return;
      throw error;
    }
  }
}
