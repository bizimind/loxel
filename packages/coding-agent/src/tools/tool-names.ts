export const CANONICAL_TOOLS = [
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
] as const;

export type CanonicalToolName = (typeof CANONICAL_TOOLS)[number];

export const TOOL_ALIASES: Record<string, CanonicalToolName> = {
  WriteTodo: "TodoWrite",
  ReadTodo: "TodoRead",
  ShellOutput: "TaskOutput",
  BashOutput: "TaskOutput",
  KillShell: "TaskStop",
};

export function normalizeToolName(input: string): CanonicalToolName | undefined {
  if ((CANONICAL_TOOLS as readonly string[]).includes(input)) {
    return input as CanonicalToolName;
  }
  return TOOL_ALIASES[input];
}
