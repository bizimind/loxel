import { dirname, join } from "node:path";

import { parse as parseYaml } from "yaml";

import { GlobalStateManager } from "../global/state.ts";
import { WtConfigSchema, type WtConfig } from "./schema.ts";

const CONFIG_FILENAME = "wt.yaml";

export interface LoadConfigOptions {
  /** Explicit repo path to use instead of searching from cwd */
  repoPath?: string;
}

export interface LoadedConfig {
  config: WtConfig;
  /** Absolute path to the config file */
  configPath: string;
  /** Absolute path to the directory containing the config (bare repo root) */
  rootDir: string;
}

/**
 * Parse and validate YAML configuration.
 * Pure function for testing.
 *
 * @param rawYaml - Raw YAML content
 * @param configPath - Path to config file (for error messages)
 * @returns Validated configuration object
 * @throws Error if YAML is invalid or doesn't match schema
 */
export function parseWtConfig(rawYaml: string, configPath: string): WtConfig {
  let rawConfig: unknown;
  try {
    rawConfig = parseYaml(rawYaml);
  } catch (err) {
    throw new Error(`Failed to parse ${configPath}: ${err}`);
  }

  const result = WtConfigSchema.safeParse(rawConfig);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid config in ${configPath}:\n${issues}`);
  }
  return result.data;
}

/**
 * Walk up from startDir looking for wt.yaml
 */
function findConfigFile(startDir: string): string | null {
  let currentDir = startDir;

  while (true) {
    const configPath = join(currentDir, CONFIG_FILENAME);
    if (Bun.file(configPath).size > 0) {
      return configPath;
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      // Reached filesystem root
      return null;
    }
    currentDir = parentDir;
  }
}

/**
 * Load configuration from a specific repo path.
 * Does not search up the directory tree.
 */
async function loadConfigFromPath(repoPath: string): Promise<LoadedConfig> {
  const configPath = join(repoPath, CONFIG_FILENAME);
  const configFile = Bun.file(configPath);

  if (!(await configFile.exists())) {
    throw new Error(`No ${CONFIG_FILENAME} found at ${repoPath}`);
  }

  let rawContent: string;
  try {
    rawContent = await configFile.text();
  } catch (err) {
    throw new Error(`Failed to read ${configPath}: ${err}`);
  }

  const config = parseWtConfig(rawContent, configPath);
  return { config, configPath, rootDir: repoPath };
}

/**
 * Load and validate wt.yaml configuration.
 *
 * Resolution order:
 * 1. If options.repoPath is provided, use it directly
 * 2. Walk up from cwd to find wt.yaml
 * 3. If not found, prompt user to select from known repos (or show error in non-TTY)
 *
 * After successful load, the repo is registered in global state.
 *
 * @throws Error if config not found or invalid
 */
export async function loadConfig(
  cwd: string = process.cwd(),
  options?: LoadConfigOptions,
): Promise<LoadedConfig> {
  let result: LoadedConfig;

  if (options?.repoPath) {
    // Use explicit repo path
    result = await loadConfigFromPath(options.repoPath);
  } else {
    // Try to find config in cwd tree
    const configPath = findConfigFile(cwd);

    if (configPath) {
      const configFile = Bun.file(configPath);
      let rawContent: string;

      try {
        rawContent = await configFile.text();
      } catch (err) {
        throw new Error(`Failed to read ${configPath}: ${err}`);
      }

      const config = parseWtConfig(rawContent, configPath);
      result = { config, configPath, rootDir: dirname(configPath) };
    } else {
      // Fall back to repo selection (lazy import to avoid test issues with @inquirer/prompts)
      const { selectRepo } = await import("../global/select.ts");
      const selectedPath = await selectRepo();
      result = await loadConfigFromPath(selectedPath);
    }
  }

  // Register repo in global state (fire and forget, don't block on errors)
  new GlobalStateManager().register(result.rootDir).catch(() => {});

  return result;
}

/**
 * Resolve config for CLI commands.
 * Walks up from cwd to find wt.yaml when no explicit repoPath is provided.
 * CLI commands should use this instead of calling loadConfig directly.
 *
 * @param repoPath - Explicit repo path from --repo flag, or undefined to walk up from cwd
 */
export function resolveConfig(repoPath?: string): Promise<LoadedConfig> {
  return loadConfig(process.cwd(), { repoPath });
}

/**
 * Get the absolute path to the worktrees directory.
 */
export function getWorktreesDir(loaded: LoadedConfig): string {
  return join(loaded.rootDir, loaded.config.worktrees_dir);
}
