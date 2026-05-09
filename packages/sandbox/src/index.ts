// Sandbox
export { Sandbox } from "./sandbox.ts";
export {
  SandboxTemplate,
  SDK_LABEL,
  SDK_LABEL_VALUE,
  type SandboxTemplateOptions,
} from "./sandbox-template.ts";

// Provider interface & factory
export { createProvider } from "./create-provider.ts";
export type {
  ExecOptions,
  ExecResult,
  ListFilter,
  LogsOptions,
  ProviderType,
  RunContainerOptions,
  SandboxProvider,
  SpawnOptions,
} from "./provider.ts";

// Exec handle
export type { ExecHandle } from "./exec-handle.ts";

// Schemas & types
export {
  SandboxSpecSchema,
  VolumeSchema,
  PortMappingSchema,
  ResourcesSchema,
  CONTAINER_NAME_RE,
  type SandboxSpec,
  type SandboxSpecInput,
  type Volume,
  type PortMapping,
  type Resources,
} from "./sandbox-spec.ts";
export {
  ContainerInfoSchema,
  ContainerStateSchema,
  type ContainerInfo,
  type ContainerState,
} from "./container-info.ts";

// Detection
export { detectProviders, detectPreferredProvider } from "./detect.ts";

// Errors
export {
  SandboxError,
  ProviderNotFoundError,
  ContainerNotFoundError,
  CliError,
  type SandboxErrorCode,
  type SandboxErrorOptions,
} from "./errors.ts";

// Individual providers (for direct instantiation)
export { AppleContainerProvider } from "./providers/apple.ts";
export { DockerProvider } from "./providers/docker.ts";
export { PodmanProvider } from "./providers/podman.ts";
