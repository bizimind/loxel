import { Command } from "commander";

import { formatKeyValue } from "../formatters.ts";
import { createResult } from "../result.ts";
import { runAction } from "../runner.ts";
import type { UpdateConfig } from "../update/index.ts";
import { createUpdateSystem } from "../update/index.ts";
import { getCurrentPlatform } from "../update/platform.ts";

export interface VersionOptions {
  json?: boolean;
  check?: boolean;
}

export interface VersionResult {
  version: string;
  platform: string;
  binary: string;
  update?: { available: boolean; latestVersion: string };
}

/**
 * Execute the version command logic.
 */
export async function runVersionCommand(
  config: UpdateConfig,
  options: VersionOptions = {},
): Promise<VersionResult> {
  const updateSystem = createUpdateSystem(config);

  const result: VersionResult = {
    version: config.getCurrentVersion(),
    platform: getCurrentPlatform(),
    binary: process.execPath,
  };

  if (options.check) {
    try {
      const updateInfo = await updateSystem.checkForUpdates({ skipCache: true });
      result.update = { available: updateInfo.hasUpdate, latestVersion: updateInfo.latestVersion };
    } catch (err) {
      if (!options.json) {
        process.stderr.write(`\nFailed to check for updates: ${err}\n`);
      }
    }
  }

  return result;
}

/**
 * Format version result for human-readable output.
 */
export function formatVersionResult(packageName: string, result: VersionResult): string {
  const lines = [
    `${packageName} version ${result.version}`,
    formatKeyValue({ platform: result.platform, binary: result.binary }),
  ];

  if (result.update) {
    if (result.update.available) {
      lines.push("");
      lines.push(`Update available: ${result.update.latestVersion}`);
      lines.push(`Run '${packageName} update' to install`);
    } else {
      lines.push("");
      lines.push("You're on the latest version");
    }
  }

  return lines.join("\n");
}

/**
 * Print version result in human-readable format.
 * @deprecated Use createVersionCommand with runAction pattern instead.
 */
export function printVersionHuman(packageName: string, result: VersionResult): void {
  process.stdout.write(formatVersionResult(packageName, result) + "\n");
}

/**
 * Print version result as JSON.
 * @deprecated Use createVersionCommand with runAction pattern instead.
 */
export function printVersionJson(result: VersionResult): void {
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

/**
 * Create a version command for Commander.
 */
export function createVersionCommand(config: UpdateConfig): Command {
  return new Command("version")
    .description("Show version information")
    .option("-j, --json", "Output as JSON")
    .option("-c, --check", "Check for available updates")
    .action(async (opts: VersionOptions) => {
      await runAction<VersionResult>(opts, async () => {
        const result = await runVersionCommand(config, opts);
        return createResult(result, (r) => formatVersionResult(config.packageName, r));
      });
    });
}
