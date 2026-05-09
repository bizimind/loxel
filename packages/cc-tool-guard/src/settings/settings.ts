import { homedir } from "node:os";
import { join } from "node:path";

import type { SettingsTarget, SupportedTool } from "../types.ts";

interface Settings {
  permissions?: { allow?: string[]; deny?: string[] };
  [key: string]: unknown;
}

/**
 * Resolve the settings file path from a SettingsTarget
 */
function resolveSettingsPath(target: Exclude<SettingsTarget, { type: "none" }>): {
  dir: string;
  path: string;
} {
  switch (target.type) {
    case "user": {
      const userDir = join(homedir(), ".claude");
      return { dir: userDir, path: join(userDir, "settings.json") };
    }
    case "project": {
      const projectDir = join(target.projectRoot, ".claude");
      return { dir: projectDir, path: join(projectDir, "settings.json") };
    }
    case "local": {
      const localDir = join(target.projectRoot, ".claude");
      return { dir: localDir, path: join(localDir, "settings.local.json") };
    }
    default: {
      const _exhaustive: never = target;
      throw new Error(`Unknown settings target: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Add a tool pattern to the specified settings file's allow list
 * Claude Code picks up settings changes in real-time
 */
export async function addAllowedPattern(
  pattern: string,
  target: SettingsTarget,
  toolName: SupportedTool = "Bash",
): Promise<void> {
  if (target.type === "none") {
    return;
  }

  const { dir: settingsDir, path: settingsPath } = resolveSettingsPath(target);

  const settings = await readSettings(settingsPath);
  ensurePermissionsArray(settings);

  const toolPattern = `${toolName}(${pattern})`;

  // Skip if pattern already exists
  if (settings.permissions!.allow!.includes(toolPattern)) {
    return;
  }

  settings.permissions!.allow!.push(toolPattern);
  await writeSettings(settingsDir, settingsPath, settings);
}

async function readSettings(settingsPath: string): Promise<Settings> {
  const file = Bun.file(settingsPath);
  if (await file.exists()) {
    try {
      return await file.json();
    } catch (error) {
      console.error(`[cc-tool-guard] Error reading settings: ${error}`);
    }
  }
  return {};
}

function ensurePermissionsArray(settings: Settings): void {
  if (!settings.permissions) {
    settings.permissions = {};
  }
  if (!settings.permissions.allow) {
    settings.permissions.allow = [];
  }
}

async function writeSettings(
  settingsDir: string,
  settingsPath: string,
  settings: Settings,
): Promise<void> {
  await Bun.$`mkdir -p ${settingsDir}`.quiet().nothrow();
  try {
    await Bun.write(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  } catch (error) {
    console.error(`[cc-tool-guard] Error writing settings: ${error}`);
    throw error;
  }
}
