import type { CanonicalToolName } from "./tool-names.ts";

export type ToolProfile = "execute" | "plan" | "minimal";

const EXECUTE_SET: ReadonlySet<CanonicalToolName> = new Set([
  "Read",
  "Edit",
  "Write",
  "MultiEdit",
  "Glob",
  "Grep",
  "Bash",
  "WebFetch",
  "WebSearch",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "Task",
  "TaskOutput",
  "TaskStop",
  "TodoWrite",
  "TodoRead",
  "ToolSearch",
  "Skill",
]);

const PLAN_SET: ReadonlySet<CanonicalToolName> = new Set([
  "Read",
  "Edit",
  "Write",
  "MultiEdit",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "Task",
  "TaskOutput",
  "TaskStop",
  "TodoRead",
  "ToolSearch",
]);

const MINIMAL_SET: ReadonlySet<CanonicalToolName> = new Set([
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "AskUserQuestion",
  "ToolSearch",
  "TodoRead",
]);

export function isToolAllowedInProfile(profile: ToolProfile, toolName: CanonicalToolName): boolean {
  switch (profile) {
    case "execute":
      return EXECUTE_SET.has(toolName);
    case "plan":
      return PLAN_SET.has(toolName);
    case "minimal":
      return MINIMAL_SET.has(toolName);
    default: {
      const _exhaustive: never = profile;
      throw new Error(`Unknown tool profile: ${String(_exhaustive)}`);
    }
  }
}

export function getAllowedToolsForProfile(profile: ToolProfile): CanonicalToolName[] {
  const target = (() => {
    switch (profile) {
      case "execute":
        return EXECUTE_SET;
      case "plan":
        return PLAN_SET;
      case "minimal":
        return MINIMAL_SET;
      default: {
        const _exhaustive: never = profile;
        throw new Error(`Unknown tool profile: ${String(_exhaustive)}`);
      }
    }
  })();

  return Array.from(target.values());
}
