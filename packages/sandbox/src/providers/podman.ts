import { ProviderNotFoundError } from "../errors.ts";
import { runCli } from "../exec.ts";
import { BaseOciProvider } from "./base-oci.ts";

export class PodmanProvider extends BaseOciProvider {
  readonly type = "podman" as const;
  readonly bin = "podman";

  async ensureReady(): Promise<void> {
    // `podman info` verifies the daemon/machine is running and connectable
    const result = await runCli([this.bin, "info"], { throwOnError: false });
    if (result.exitCode !== 0) {
      throw new ProviderNotFoundError(this.type);
    }
  }

  /** Podman `ps --format json` outputs a JSON array. */
  parseListOutput(stdout: string): unknown[] {
    const parsed: unknown = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed : [];
  }
}
