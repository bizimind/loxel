// Re-export Commander for consistent version across CLIs
export { Command } from "commander";

// Output context
export {
  createOutputContext,
  getOutputMode,
  type OutputContext,
  type OutputMode,
} from "./output.ts";

// Command result and runner
export {
  createResult,
  errorResult,
  wrapError,
  type CommandResult,
  type ErrorData,
} from "./result.ts";
export { printResult, runAction, runActionSync, type RunOptions } from "./runner.ts";

// Formatters for human-readable output
export {
  formatDuration,
  formatKeyValue,
  formatList,
  formatSection,
  formatSections,
  formatStatus,
  formatTable,
} from "./formatters.ts";

// Update system
export {
  // Core types and functions
  checkForUpdates,
  checkForUpdatesWithCache,
  cleanupFailedUpdate,
  compareVersions,
  createUpdateSystem,
  downloadAndVerify,
  fetchManifest,
  getBinaryInfo,
  getCurrentPlatform,
  isRunningCompiled,
  ManifestSchema,
  maybeAutoUpdate,
  performUpdate,
  shouldCheckForUpdates,
  // Types
  type BinaryInfo,
  type CacheConfig,
  type CachedUpdateCheckResult,
  type Manifest,
  type MaybeAutoUpdateConfig,
  type PerformUpdateOptions,
  type Platform,
  type UpdateCheckResult,
  type UpdateConfig,
} from "./update/index.ts";

// Command factories
export {
  createUpdateCommand,
  createVersionCommand,
  formatUpdateResult,
  formatVersionResult,
  printUpdateHuman,
  printUpdateJson,
  printVersionHuman,
  printVersionJson,
  runUpdateCommand,
  runVersionCommand,
  type UpdateOptions,
  type UpdateResult,
  type VersionOptions,
  type VersionResult,
} from "./commands/index.ts";

// Logging utilities
export {
  createCliLogger,
  logCliError,
  parseCliContext,
  resolveLoggingConfig,
  type BuildType,
  type CliContext,
  type CliLoggingConfig,
  type ResolvedLoggingConfig,
} from "./logging.ts";

// Re-export logger types for convenience
export type { AppLogger, LogSource } from "@bizimind/logger";
