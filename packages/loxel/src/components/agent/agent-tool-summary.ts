import { abbreviateHomePath } from "@/lib/home-path";
import { isRecord } from "@/lib/is-record";

/** The input field that says best what a tool call does, by tool. */
const SUMMARY_FIELDS: Record<string, readonly string[]> = {
  Bash: ["command"],
  Read: ["file_path"],
  Write: ["file_path"],
  Edit: ["file_path"],
  MultiEdit: ["file_path"],
  NotebookEdit: ["notebook_path"],
  Glob: ["pattern"],
  Grep: ["pattern"],
  WebFetch: ["url"],
  WebSearch: ["query"],
  Task: ["description"],
  Agent: ["description"],
  Skill: ["skill"],
};

const FALLBACK_FIELDS = ["description", "command", "file_path", "path", "pattern", "query", "url"];

/** `path` relative to `root` when inside it, else with the home directory as `~`. */
export function displayPath(path: string, root: string | null, home: string | null): string {
  if (root && path.startsWith(`${root}/`)) return path.slice(root.length + 1);
  return abbreviateHomePath(path, home);
}

/** One line for a tool call's collapsed row: `npm --version`, a path, a pattern. */
export function toolSummary(
  name: string,
  input: unknown,
  paths: { root: string | null; home: string | null } = { root: null, home: null },
): string {
  if (!isRecord(input)) return "";
  for (const field of SUMMARY_FIELDS[name] ?? FALLBACK_FIELDS) {
    const value = input[field];
    if (typeof value !== "string" || !value.trim()) continue;
    const line = value.trim().split("\n")[0] ?? "";
    return field.endsWith("_path") ? displayPath(line, paths.root, paths.home) : line;
  }
  return "";
}

/** Whether a tool call starts a subagent, whose messages nest under it. */
export function isSubagentTool(name: string): boolean {
  return name === "Task" || name === "Agent";
}
