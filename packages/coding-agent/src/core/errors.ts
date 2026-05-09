export type ToolErrorCode =
  | "TOOL_VALIDATION_UNKNOWN_FIELD"
  | "TOOL_VALIDATION_FAILED"
  | "TOOL_NOT_IN_PROFILE"
  | "TOOL_NOT_AVAILABLE"
  | "TOOL_PERMISSION_DENIED"
  | "TOOL_POLICY_VIOLATION"
  | "TOOL_TIMEOUT"
  | "TOOL_RUNTIME_ERROR"
  | "WEBSEARCH_UNAVAILABLE";

export interface ToolError {
  code: ToolErrorCode;
  message: string;
  retriable: boolean;
  suggested_fix: string;
}

/**
 * Typed result returned by tool execute() for policy violations.
 * The orchestrator loop checks `_type` to set `is_error` on tool.call.result events.
 */
export interface ToolPolicyViolationResult {
  _type: "policy_violation";
  code: ToolErrorCode;
  message: string;
  suggested_fix: string;
}

export function isToolPolicyViolation(value: unknown): value is ToolPolicyViolationResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "_type" in value &&
    (value as Record<string, unknown>)._type === "policy_violation"
  );
}

export class CodingAgentError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retriable = false,
  ) {
    super(message);
    this.name = "CodingAgentError";
  }
}

/**
 * Error thrown when loop control decides to break the agent loop.
 * This is not a real error - it's a control flow mechanism.
 */
export class LoopControlBreakError extends Error {
  constructor(
    public readonly reason: string,
    public readonly userMessage: string,
  ) {
    super(`Loop control break: ${reason}`);
    this.name = "LoopControlBreakError";
  }
}

export function toToolError(
  code: ToolErrorCode,
  message: string,
  retriable: boolean,
  suggestedFix: string,
): ToolError {
  return { code, message, retriable, suggested_fix: suggestedFix };
}
