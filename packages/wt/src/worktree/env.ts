import type { PortOffsetingConfig, UniqueNamingConfig, WtConfig } from "../config/schema.ts";

/**
 * Compute the WT_PORT_OFFSET value for a worktree.
 *
 * @param index - The worktree's allocated index (0, 1, 2, ...)
 * @param config - Port offsetting configuration
 * @returns The port offset value (e.g., 0, 10, 20 for offset=10)
 */
export function computePortOffset(index: number, config: PortOffsetingConfig): number {
  return index * config.offset;
}

/**
 * Compute individual port env vars with offsets applied.
 *
 * @param portOffset - The WT_PORT_OFFSET value
 * @param config - Port offsetting configuration
 * @returns Map of env var name to offset port number
 */
export function computeOffsetPorts(
  portOffset: number,
  config: PortOffsetingConfig,
): Record<string, number> {
  const result: Record<string, number> = {};

  if (config.ports) {
    for (const [envName, basePort] of Object.entries(config.ports)) {
      result[envName] = basePort + portOffset;
    }
  }

  return result;
}

/**
 * Generate WT_ALL_PORTS_OFFSETS as a string suitable for appending to .env files.
 * Format: KEY1=value1\nKEY2=value2\n...
 *
 * @param offsetPorts - Map of env var name to offset port number
 * @returns Newline-separated KEY=value pairs
 */
export function computeAllPortsOffsets(offsetPorts: Record<string, number>): string {
  return Object.entries(offsetPorts)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

/**
 * Generate WT_ALL_PORTS_OFFSETS_JSON for use with jq.
 *
 * @param offsetPorts - Map of env var name to offset port number
 * @returns JSON string of the ports object
 */
export function computeAllPortsOffsetsJson(offsetPorts: Record<string, number>): string {
  return JSON.stringify(offsetPorts);
}

// Base62 characters for random name generation (letters first to ensure starting with a letter)
const BASE62_LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const BASE62_ALL = BASE62_LETTERS + "0123456789";

/**
 * Generate a random 8-character base62 string that starts with a letter.
 */
function generateRandomName(): string {
  // First character must be a letter
  const firstChar = BASE62_LETTERS[Math.floor(Math.random() * BASE62_LETTERS.length)];

  // Remaining 7 characters can be any base62
  let rest = "";
  for (let i = 0; i < 7; i++) {
    rest += BASE62_ALL[Math.floor(Math.random() * BASE62_ALL.length)];
  }

  return firstChar + rest;
}

/**
 * Normalize a worktree name for use as a unique identifier.
 * - Replaces special characters with hyphens
 * - Removes leading/trailing hyphens
 * - Collapses consecutive hyphens
 * - Converts to lowercase
 */
function normalizeWorktreeName(name: string): string {
  let result = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-");
  while (result.startsWith("-")) result = result.slice(1);
  while (result.endsWith("-")) result = result.slice(0, -1);
  return result;
}

/**
 * Compute the WT_UNIQUE_NAME value based on strategy.
 *
 * @param worktreeName - The worktree name
 * @param strategy - 'random' or 'worktree-name'
 * @returns The unique name string
 */
export function computeUniqueName(
  worktreeName: string,
  strategy: "random" | "worktree-name",
): string {
  switch (strategy) {
    case "random":
      return generateRandomName();
    case "worktree-name":
      return normalizeWorktreeName(worktreeName);
    default: {
      const _exhaustive: never = strategy;
      throw new Error(`Unknown unique naming strategy: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Expand template strings containing ${WT_UNIQUE_NAME} and ${WT_PORT_OFFSET}.
 *
 * @param uniqueName - The computed unique name
 * @param config - Unique naming configuration
 * @param portOffset - Optional port offset value for ${WT_PORT_OFFSET} substitution
 * @returns Map of env var name to expanded value
 */
export function computeUniqueEnvs(
  uniqueName: string,
  config: UniqueNamingConfig,
  portOffset?: number,
): Record<string, string> {
  const result: Record<string, string> = {};

  if (config.envs) {
    for (const [envName, template] of Object.entries(config.envs)) {
      let value = template.replace(/\$\{WT_UNIQUE_NAME\}/g, uniqueName);
      if (portOffset !== undefined) {
        value = value.replace(/\$\{WT_PORT_OFFSET\}/g, String(portOffset));
      }
      result[envName] = value;
    }
  }

  return result;
}

/**
 * Compute all environment variables for a worktree.
 * This is the main function to call when setting up hook environment.
 *
 * @param worktreeName - The worktree name
 * @param worktreePath - Absolute path to the worktree
 * @param rootDir - Absolute path to the bare repo root
 * @param index - The worktree's allocated index
 * @param config - Full wt.yaml configuration
 * @returns Map of all env vars to set for hooks
 */
export function computeAllEnvVars(
  worktreeName: string,
  worktreePath: string,
  rootDir: string,
  index: number,
  config: WtConfig,
): Record<string, string> {
  const env: Record<string, string> = {
    WT_NAME: worktreeName,
    WT_PATH: worktreePath,
    WT_ROOT: rootDir,
  };

  // Port offsetting
  if (config.port_offseting.enable) {
    const portOffset = computePortOffset(index, config.port_offseting);
    env.WT_PORT_OFFSET = String(portOffset);

    const offsetPorts = computeOffsetPorts(portOffset, config.port_offseting);
    for (const [key, value] of Object.entries(offsetPorts)) {
      env[key] = String(value);
    }

    env.WT_ALL_PORTS_OFFSETS = computeAllPortsOffsets(offsetPorts);
    env.WT_ALL_PORTS_OFFSETS_JSON = computeAllPortsOffsetsJson(offsetPorts);
  }

  // Unique naming
  if (config.unique_naming.enable) {
    const uniqueName = computeUniqueName(worktreeName, config.unique_naming.strategy);
    env.WT_UNIQUE_NAME = uniqueName;

    // Pass port offset for ${WT_PORT_OFFSET} substitution in unique_naming.envs
    const portOffset = config.port_offseting.enable
      ? computePortOffset(index, config.port_offseting)
      : undefined;
    const uniqueEnvs = computeUniqueEnvs(uniqueName, config.unique_naming, portOffset);
    for (const [key, value] of Object.entries(uniqueEnvs)) {
      env[key] = value;
    }
  }

  return env;
}
