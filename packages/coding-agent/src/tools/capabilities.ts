import type { CanonicalToolName } from "./tool-names.ts";
import { normalizeToolName } from "./tool-names.ts";

export const DOCUMENTED_TOOLS = [
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
  "LS",
] as const;

export const LATENT_TOOLS = [
  "BashOutput",
  "KillShell",
  "ShellOutput",
  "ReadTodo",
  "WriteTodo",
] as const;

export function normalizeDeclaredTools(
  raw: string[] | null | undefined,
): CanonicalToolName[] | null {
  if (!raw || raw.length === 0) {
    return null;
  }

  const out = new Set<CanonicalToolName>();
  for (const item of raw) {
    const normalized = normalizeToolName(item);
    if (normalized) {
      out.add(normalized);
    }
  }

  return Array.from(out.values());
}

export function intersectWithDeclared(
  allowed: CanonicalToolName[],
  declared: CanonicalToolName[] | null | undefined,
): CanonicalToolName[] {
  if (!declared || declared.length === 0) {
    return allowed;
  }

  const declaredSet = new Set(declared);
  return allowed.filter((toolName) => declaredSet.has(toolName));
}

export function buildCapabilityFallbackHints(
  declared: CanonicalToolName[] | null | undefined,
): string[] {
  if (!declared || declared.length === 0) {
    return [];
  }

  const hints: string[] = [];
  if (!declared.includes("Glob")) {
    hints.push(
      "Glob unavailable: avoid directory listing instructions that require glob patterns.",
    );
  } else {
    hints.push("If LS is unavailable, list directory entries with Glob pattern '*'.");
  }
  if (!declared.includes("TaskOutput") || !declared.includes("TaskStop")) {
    hints.push(
      "Background task controls may be limited when TaskOutput/TaskStop are not declared.",
    );
  }
  return hints;
}
