import { z } from "zod";

export const VolumeSchema = z.object({
  /** Absolute path on the host */
  host: z.string(),
  /** Absolute path inside the container */
  container: z.string(),
  /** Mount as read-only */
  readonly: z.boolean().default(false),
});

export type Volume = z.infer<typeof VolumeSchema>;

export const PortMappingSchema = z.object({
  /** Host port (0 for auto-assign) */
  host: z.number().int().min(0),
  /** Container port */
  container: z.number().int().positive(),
  /** Protocol */
  protocol: z.enum(["tcp", "udp"]).default("tcp"),
});

export type PortMapping = z.infer<typeof PortMappingSchema>;

export const ResourcesSchema = z.object({
  /** CPU cores (fractional allowed, e.g. 0.5 or 2) */
  cpus: z.number().positive().optional(),
  /** Memory limit, e.g. "512m", "2g" */
  memory: z.string().min(1).optional(),
});

export type Resources = z.infer<typeof ResourcesSchema>;

/** Regex for valid container names. */
export const CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

export const SandboxSpecSchema = z.object({
  /**
   * Container name or name prefix.
   * When used as a prefix (default), `create()` appends a unique suffix.
   * Pass `name` in overrides to use an exact name instead.
   */
  name: z.string().min(1).regex(CONTAINER_NAME_RE, "Invalid container name"),
  /** OCI image reference */
  image: z.string().min(1),
  /** Command to run (overrides image CMD) */
  command: z.array(z.string()).optional(),
  /** Environment variables */
  env: z.record(z.string(), z.string()).default({}),
  /** Working directory inside the container */
  workdir: z.string().optional(),
  /** User to run as — "uid:gid" or "name" */
  user: z.string().optional(),
  /** Hostname inside the container */
  hostname: z.string().optional(),
  /** Network mode — "host", "none", or a named network */
  network: z.string().optional(),
  /** Additional volume mounts */
  volumes: z.array(VolumeSchema).default([]),
  /** Port mappings */
  ports: z.array(PortMappingSchema).default([]),
  /** Labels — merged with the SDK baseline label */
  labels: z.record(z.string(), z.string()).default({}),
  /** Resource constraints */
  resources: ResourcesSchema.optional(),
  /** Remove container automatically on exit */
  autoRemove: z.boolean().default(false),
  /** Escape-hatch raw CLI args appended before the image reference */
  providerArgs: z.array(z.string()).default([]),
});

/** Parsed spec with all defaults applied. */
export type SandboxSpec = z.infer<typeof SandboxSpecSchema>;

/** Input type — accepts partial objects (defaults not yet applied). */
export type SandboxSpecInput = z.input<typeof SandboxSpecSchema>;
