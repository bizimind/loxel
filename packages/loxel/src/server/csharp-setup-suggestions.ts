/** The .NET commands workspace setup suggests for a project directory. */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DOTNET_RESTORE_TARGET = /\.(sln|slnx|csproj)$/;
const DOTNET_SOLUTION = /\.(sln|slnx)$/;
/** Restricted to names that need no shell quoting. */
const DOTNET_UNQUOTED_NAME = /^[\w.-]+$/;
const DOTNET_TOOL_MANIFESTS = [".config/dotnet-tools.json", "dotnet-tools.json"];

/**
 * `dotnet tool restore` for a local tool manifest and `dotnet restore` for a root solution or
 * project. Restored dependencies are per worktree: `obj` is git-ignored and holds absolute paths.
 * With several candidates at the root, plain `dotnet restore` refuses to choose and would abort the
 * setup hook, so the only solution among them is named, and without one nothing is suggested.
 */
export function csharpSetupCommands(dirPath: string): string[] {
  const commands: string[] = [];
  if (DOTNET_TOOL_MANIFESTS.some((file) => existsSync(join(dirPath, file)))) {
    commands.push("dotnet tool restore");
  }
  let names: string[];
  try {
    names = readdirSync(dirPath).filter((name) => DOTNET_RESTORE_TARGET.test(name));
  } catch {
    return commands;
  }
  if (names.length === 1) return [...commands, "dotnet restore"];
  const solutions = names.filter((name) => DOTNET_SOLUTION.test(name));
  const [solution] = solutions;
  if (solutions.length === 1 && solution && DOTNET_UNQUOTED_NAME.test(solution)) {
    commands.push(`dotnet restore ${solution}`);
  }
  return commands;
}
