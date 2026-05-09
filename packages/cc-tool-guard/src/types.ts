/**
 * Tool input for Bash commands
 */
export interface BashToolInput {
  command: string;
  description?: string;
  timeout?: number;
}

/**
 * Tool input for Read operations
 */
export interface ReadToolInput {
  file_path: string;
  limit?: number;
  offset?: number;
}

/**
 * Input received from Claude Code via stdin for PermissionRequest hook
 */
export interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: string;
  hook_event_name: "PermissionRequest";
  tool_name: string;
  tool_input: BashToolInput | ReadToolInput | Record<string, unknown>;
}

/**
 * Output to Claude Code via stdout for PermissionRequest hook
 * Uses the nested hookSpecificOutput structure required by Claude Code
 */
export interface HookOutput {
  hookSpecificOutput: {
    hookEventName: "PermissionRequest";
    decision: {
      behavior: "allow" | "deny";
      message?: string; // for deny only
    };
  };
}

/**
 * Project context for command evaluation
 */
export interface ProjectContext {
  projectRoot: string;
  currentBranch: string;
  cwd: string;
  isGitRepo: boolean;
}

/**
 * Evaluation path taken during command evaluation
 */
export type EvaluationPath = "pattern-safe" | "pattern-unsafe" | "haiku" | "haiku-failed";

/**
 * Error that occurred during evaluation
 */
export interface EvaluationError {
  stage: "haiku-call" | "haiku-parse" | "haiku-validation";
  message: string;
  attempt?: number;
}

/**
 * Result from command evaluation
 */
export interface EvaluationResult {
  classification: "safe" | "uncertain";
  reason: string;
  suggestedPattern?: string;
  evaluationPath?: EvaluationPath;
  errors?: EvaluationError[];
}

/**
 * Supported tool names for evaluation
 */
export type SupportedTool = "Bash" | "Read";

/**
 * Update mode values accepted by --update flag
 */
export type UpdateMode = "none" | "user" | "project" | "local";

/**
 * Target location for persisting allowed patterns
 */
export type SettingsTarget =
  | { type: "none" }
  | { type: "user" }
  | { type: "project"; projectRoot: string }
  | { type: "local"; projectRoot: string };
