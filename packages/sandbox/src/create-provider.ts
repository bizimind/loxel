import type { ProviderType, SandboxProvider } from "./provider.ts";
import { AppleContainerProvider } from "./providers/apple.ts";
import { DockerProvider } from "./providers/docker.ts";
import { PodmanProvider } from "./providers/podman.ts";

/** Create a provider instance for the given type. */
export function createProvider(type: ProviderType): SandboxProvider {
  switch (type) {
    case "apple":
      return new AppleContainerProvider();
    case "podman":
      return new PodmanProvider();
    case "docker":
      return new DockerProvider();
    default: {
      const _exhaustive: never = type;
      throw new Error(`Unknown provider type: ${String(_exhaustive)}`);
    }
  }
}
