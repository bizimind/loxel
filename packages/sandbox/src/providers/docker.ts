import { ProviderNotFoundError } from "../errors.ts";
import { runCli } from "../exec.ts";
import { BaseOciProvider } from "./base-oci.ts";

export class DockerProvider extends BaseOciProvider {
  readonly type = "docker" as const;
  readonly bin = "docker";

  async ensureReady(): Promise<void> {
    const result = await runCli([this.bin, "info"], { throwOnError: false });
    if (result.exitCode !== 0) {
      throw new ProviderNotFoundError(this.type);
    }
  }

  /** Docker `ps --format json` outputs one JSON object per line (NOT an array). */
  parseListOutput(stdout: string): unknown[] {
    return stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
  }
}
