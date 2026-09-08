/**
 * cc-tool-guard - A PermissionRequest hook for Claude Code
 *
 * Evaluates Bash commands and Read operations to auto-approve safe operations
 * and defer uncertain ones to user confirmation.
 */

import { mkdir, appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { getProjectContext } from "./context/project.ts";
import { evaluateBashCommand, evaluateReadFile } from "./evaluator/evaluator.ts";
import { addAllowedPattern } from "./settings/settings.ts";
import type {
  HookInput,
  HookOutput,
  BashToolInput,
  ReadToolInput,
  SupportedTool,
  EvaluationResult,
  EvaluationPath,
  EvaluationError,
  ProjectContext,
  UpdateMode,
  SettingsTarget,
} from "./types.ts";

const SUPPORTED_TOOLS: SupportedTool[] = ["Bash", "Read"];
const VALID_UPDATE_MODES: UpdateMode[] = ["none", "user", "project", "local"];
const DEFAULT_UPDATE_MODE: UpdateMode = "none";

/** Log directory and file path */
const LOG_DIR = join(homedir(), ".local", "state", "loxel", "cc-tool-guard");
const LOG_FILE = join(LOG_DIR, "calls-log.jsonl");

/** Log entry structure */
interface LogEntry {
  timestamp: string;
  duration_ms: number;
  tool_name: SupportedTool;
  tool_input: string;
  project_context: ProjectContext;
  evaluation_path: EvaluationPath;
  classification: "safe" | "uncertain";
  reason: string;
  suggested_pattern?: string;
  output: "allow" | "ask";
  errors?: EvaluationError[];
}

/**
 * Append a log entry to the JSONL log file
 * Uses appendFile with O_APPEND which is atomic for small writes (<PIPE_BUF)
 */
async function appendLog(entry: LogEntry): Promise<void> {
  try {
    await mkdir(LOG_DIR, { recursive: true });
    await appendFile(LOG_FILE, JSON.stringify(entry) + "\n", "utf8");
  } catch (error) {
    // Log errors to stderr but don't fail the hook
    console.error(`[cc-tool-guard] Failed to write log: ${error}`);
  }
}

/**
 * Parse --update flag from command line arguments
 */
function parseUpdateMode(args: string[]): UpdateMode {
  const updateIndex = args.indexOf("--update");
  if (updateIndex === -1) {
    return DEFAULT_UPDATE_MODE;
  }

  const modeValue = args[updateIndex + 1];
  if (!modeValue || modeValue.startsWith("-")) {
    console.error(`[cc-tool-guard] --update requires a value: ${VALID_UPDATE_MODES.join(", ")}`);
    process.exit(1);
  }

  if (!VALID_UPDATE_MODES.includes(modeValue as UpdateMode)) {
    console.error(
      `[cc-tool-guard] Invalid update mode: ${modeValue}. Valid modes: ${VALID_UPDATE_MODES.join(", ")}`,
    );
    process.exit(1);
  }

  return modeValue as UpdateMode;
}

/**
 * Build SettingsTarget from update mode and project root
 */
function buildSettingsTarget(mode: UpdateMode, projectRoot: string): SettingsTarget {
  switch (mode) {
    case "none":
      return { type: "none" };
    case "user":
      return { type: "user" };
    case "project":
      return { type: "project", projectRoot };
    case "local":
      return { type: "local", projectRoot };
    default: {
      const _exhaustive: never = mode;
      throw new Error(`Unknown update mode: ${String(_exhaustive)}`);
    }
  }
}

async function main() {
  const startTime = performance.now();

  // Parse CLI arguments
  const args = process.argv.slice(2);
  const updateMode = parseUpdateMode(args);

  // Read JSON from stdin
  const input = await Bun.stdin.text();

  let hookInput: HookInput;
  try {
    hookInput = JSON.parse(input);
  } catch (error) {
    console.error(`[cc-tool-guard] Failed to parse input: ${error}`);
    process.exit(1);
  }

  // Only process supported tools
  if (!SUPPORTED_TOOLS.includes(hookInput.tool_name as SupportedTool)) {
    // For unsupported tools, don't output anything - let normal flow handle it
    process.exit(0);
  }

  const cwd = hookInput.cwd;
  const toolName = hookInput.tool_name as SupportedTool;

  // Get project context
  const context = await getProjectContext(cwd);

  // Evaluate based on tool type
  let result: EvaluationResult;
  let toolInput: string;

  if (toolName === "Bash") {
    const command = (hookInput.tool_input as BashToolInput)?.command;
    if (!command) {
      // No command to evaluate
      process.exit(0);
    }
    toolInput = command;
    result = await evaluateBashCommand(command, context);
  } else if (toolName === "Read") {
    const filePath = (hookInput.tool_input as ReadToolInput)?.file_path;
    if (!filePath) {
      // No file path to evaluate
      process.exit(0);
    }
    toolInput = filePath;
    result = evaluateReadFile(filePath, context);
  } else {
    // Should not reach here due to SUPPORTED_TOOLS check
    process.exit(0);
  }

  const duration_ms = Math.round(performance.now() - startTime);

  // Build settings target for pattern persistence
  const settingsTarget = buildSettingsTarget(updateMode, context.projectRoot);

  if (result.classification === "safe") {
    // Add pattern to settings for future auto-approval (if target is not "none")
    if (result.suggestedPattern && settingsTarget.type !== "none") {
      try {
        await addAllowedPattern(result.suggestedPattern, settingsTarget, toolName);
      } catch (error) {
        // Log but don't fail - the approval still works for this invocation
        console.error(`[cc-tool-guard] Failed to update settings: ${error}`);
      }
    }

    // Return approval using correct nested structure
    const output: HookOutput = {
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
    };

    // Log the call
    await appendLog({
      timestamp: new Date().toISOString(),
      duration_ms,
      tool_name: toolName,
      tool_input: toolInput,
      project_context: context,
      evaluation_path: result.evaluationPath ?? "pattern-safe",
      classification: result.classification,
      reason: result.reason,
      suggested_pattern: result.suggestedPattern,
      output: "allow",
      errors: result.errors,
    });

    console.log(JSON.stringify(output));
    process.exit(0);
  }

  // For uncertain classification, log and exit without output
  // This lets the normal user permission prompt appear
  await appendLog({
    timestamp: new Date().toISOString(),
    duration_ms,
    tool_name: toolName,
    tool_input: toolInput,
    project_context: context,
    evaluation_path: result.evaluationPath ?? "pattern-unsafe",
    classification: result.classification,
    reason: result.reason,
    output: "ask",
    errors: result.errors,
  });

  process.exit(0);
}

main().catch((err) => {
  console.error(`[cc-tool-guard] Unexpected error: ${err}`);
  process.exit(1);
});
