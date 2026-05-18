import { execSync } from "node:child_process";

import { Command } from "commander";

import { createResult } from "../result.ts";
import { runAction } from "../runner.ts";
import type { UpdateConfig } from "../update/index.ts";
import { createUpdateSystem } from "../update/index.ts";

export interface UpdateOptions {
  json?: boolean;
  force?: boolean;
}

export interface UpdateResult {
  updated: boolean;
  previousVersion: string;
  currentVersion: string;
}

/**
 * Execute the update command logic.
 */
export async function runUpdateCommand(
  config: UpdateConfig,
  options: UpdateOptions = {},
  onProgress?: (message: string) => void,
): Promise<UpdateResult> {
  const updateSystem = createUpdateSystem(config);

  onProgress?.("Checking for updates...");

  const updateInfo = await updateSystem.checkForUpdates({ skipCache: true });

  if (!updateInfo.hasUpdate && !options.force) {
    return {
      updated: false,
      previousVersion: updateInfo.currentVersion,
      currentVersion: updateInfo.currentVersion,
    };
  }

  onProgress?.(`Updating from ${updateInfo.currentVersion} to ${updateInfo.latestVersion}...`);

  try {
    const manifest = updateInfo.manifest ?? (await updateSystem.fetchManifest());
    await updateSystem.performUpdate(manifest);
  } catch (err) {
    await updateSystem.cleanupFailedUpdate();
    throw err;
  }

  // Verify the update by running the new binary
  let newVersion: string;
  try {
    newVersion = execSync(`"${process.execPath}" --version`, { encoding: "utf8" }).trim();
  } catch {
    newVersion = updateInfo.latestVersion;
  }

  return { updated: true, previousVersion: updateInfo.currentVersion, currentVersion: newVersion };
}

/**
 * Format update result for human-readable output.
 */
export function formatUpdateResult(result: UpdateResult): string {
  if (result.updated) {
    return `Update complete!\nNow running: ${result.currentVersion}`;
  }
  return `Already on latest version (${result.currentVersion})`;
}

/**
 * Print update result in human-readable format.
 * @deprecated Use createUpdateCommand with runAction pattern instead.
 */
export function printUpdateHuman(result: UpdateResult): void {
  process.stdout.write(formatUpdateResult(result) + "\n");
}

/**
 * Print update result as JSON.
 * @deprecated Use createUpdateCommand with runAction pattern instead.
 */
export function printUpdateJson(result: UpdateResult): void {
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

/**
 * Create an update command for Commander.
 */
export function createUpdateCommand(config: UpdateConfig): Command {
  return new Command("update")
    .description(`Update ${config.packageName} to the latest version`)
    .option("-j, --json", "Output as JSON")
    .option("-f, --force", "Force update even if on latest version")
    .action(async (opts: UpdateOptions) => {
      await runAction<UpdateResult>(opts, async (ctx) => {
        const result = await runUpdateCommand(config, opts, (msg) => ctx.log(msg));
        return createResult(result, formatUpdateResult);
      });
    });
}
