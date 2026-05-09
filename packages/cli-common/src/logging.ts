import { createLogger, createNoopLogger, type AppLogger, type LogSource } from "@bizimind/logger";

/**
 * Build type: "dev" for local builds, "release" for CI builds.
 */
export type BuildType = "dev" | "release";

/**
 * Configuration for CLI logging.
 */
export interface CliLoggingConfig {
  /** CLI/package name (must be a valid LogSource) */
  source: LogSource;
  /** Build-time injected Axiom token (use typeof check) */
  axiomTokenDefault?: string;
  /** Build-time injected Axiom dataset (use typeof check) */
  axiomDatasetDefault?: string;
  /** Build-time injected build type (use typeof check) */
  buildTypeDefault?: string;
}

/**
 * CLI context for logging - included in all log messages.
 */
export interface CliContext {
  /** CLI version */
  version: string;
  /** Build type (dev/release) */
  buildType: BuildType;
  /** Command being executed (e.g., "version", "update") */
  command?: string;
  /** Command arguments */
  args?: string[];
  /** Platform (darwin-arm64, etc.) */
  platform?: string;
}

/**
 * Result of resolving logging configuration.
 */
export interface ResolvedLoggingConfig {
  axiomToken?: string;
  axiomDataset: string;
  buildType: BuildType;
  axiomEnabled: boolean;
}

/**
 * Resolve logging configuration from build-time defaults and environment variables.
 * Environment variables take precedence over build-time defaults.
 */
export function resolveLoggingConfig(config: CliLoggingConfig): ResolvedLoggingConfig {
  const axiomToken = process.env.AXIOM_TOKEN ?? config.axiomTokenDefault;
  const axiomDataset = process.env.AXIOM_DATASET ?? config.axiomDatasetDefault ?? "loxel";
  const rawBuildType = config.buildTypeDefault ?? "dev";
  const buildType: BuildType = rawBuildType === "release" ? "release" : "dev";

  return { axiomToken, axiomDataset, buildType, axiomEnabled: !!axiomToken && !!axiomDataset };
}

/**
 * Create a CLI logger with Axiom integration.
 * Returns a no-op logger if Axiom credentials are not available.
 */
export function createCliLogger(
  config: CliLoggingConfig,
  context?: Partial<CliContext>,
): AppLogger {
  const resolved = resolveLoggingConfig(config);

  let logger: AppLogger;

  if (resolved.axiomEnabled && resolved.axiomToken) {
    logger = createLogger({
      source: config.source,
      mode: "http",
      axiomToken: resolved.axiomToken,
      axiomDataset: resolved.axiomDataset,
      level: (process.env.LOG_LEVEL as "error" | "warn" | "info" | "debug") ?? "debug",
    });
  } else {
    // Use no-op logger when Axiom is not configured
    logger = createNoopLogger();
  }

  // Add CLI context to all logs
  if (context) {
    return logger.with({ buildType: resolved.buildType, ...context });
  }

  return logger.with({ buildType: resolved.buildType });
}

/**
 * Parse CLI context from process.argv for logging.
 */
export function parseCliContext(argv: string[], version: string, buildType: BuildType): CliContext {
  const args = argv.slice(2);
  const command = args.find((arg) => !arg.startsWith("-") && !arg.startsWith("--"));

  return { version, buildType, command, args };
}

/**
 * Log a CLI error to Axiom before exiting.
 * This ensures errors are captured even for CLI commands that don't normally log.
 */
export async function logCliError(
  config: CliLoggingConfig,
  error: unknown,
  context?: Partial<CliContext>,
): Promise<void> {
  const logger = createCliLogger(config, context);
  logger.error("CLI error", { error });
  await logger.flush();
}
