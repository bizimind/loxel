/** Files to copy and commands to run that workspace setup suggests for a project directory. */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { ScanSuggestionsResult } from "@/api/project-model";

/** Detection rules for auto-suggesting workspace setup files and commands. */
const SUGGESTION_RULES: Array<{ file: string; copyFile?: string; commands?: string[] }> = [
  { file: "bun.lock", commands: ["bun i --frozen-lockfile"] },
  { file: "bun.lockb", commands: ["bun i --frozen-lockfile"] },
  { file: "pnpm-lock.yaml", commands: ["pnpm i --frozen-lockfile"] },
  { file: "package-lock.json", commands: ["npm ci"] },
  { file: "yarn.lock", commands: ["yarn install --frozen-lockfile"] },
  { file: ".env", copyFile: ".env" },
  { file: ".env.local", copyFile: ".env.local" },
  { file: ".envrc", copyFile: ".envrc", commands: ["direnv allow"] },
  { file: ".mise.toml", commands: ["mise trust", "mise i"] },
  { file: ".tool-versions", commands: ["mise trust", "mise i"] },
];

/** Python lockfiles and the command that creates the project's environment from each, by priority. */
const PYTHON_LOCKFILES: Array<{ file: string; command: string }> = [
  { file: "uv.lock", command: "uv sync" },
  { file: "poetry.lock", command: "poetry install" },
  { file: "pdm.lock", command: "pdm install" },
  { file: "Pipfile.lock", command: "pipenv install --dev" },
];

/** Restricted to names that need no shell quoting. */
const REQUIREMENTS_FILE = /^requirements[\w.-]*\.txt$/;
/** A `[tool.uv]` table or one of its subtables (`[tool.uv.workspace]`, ...). */
const TOOL_UV_TABLE = /^\s*\[\s*tool\s*\.\s*uv\s*[\].]/m;

/**
 * Suggest setup for `dirPath`. `PATH` decides between equivalent commands (uv when it is
 * installed); pass the PATH the setup hook will run with.
 */
export async function scanSetupSuggestions(
  dirPath: string,
  PATH: string,
): Promise<ScanSuggestionsResult> {
  const files: string[] = [];
  const commands: string[] = [];
  const addCommand = (cmd: string) => {
    if (!commands.includes(cmd)) commands.push(cmd);
  };

  for (const rule of SUGGESTION_RULES) {
    if (!existsSync(join(dirPath, rule.file))) continue;
    if (rule.copyFile && !files.includes(rule.copyFile)) files.push(rule.copyFile);
    for (const cmd of rule.commands ?? []) addCommand(cmd);
  }

  const python = await pythonSetupCommand(dirPath, PATH);
  if (python) addCommand(python);

  for (const cmd of dotnetSetupCommands(dirPath)) addCommand(cmd);

  return { files, commands };
}

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
function dotnetSetupCommands(dirPath: string): string[] {
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

/**
 * The command that creates a worktree's Python environment: the project manager's install for its
 * lockfile, `uv sync` for a uv project without a lockfile, else a `.venv` with the root
 * `requirements*.txt` files installed. The environment is created per worktree, never shared:
 * venvs embed absolute paths, and editable installs point at one checkout.
 */
async function pythonSetupCommand(dirPath: string, PATH: string): Promise<string | null> {
  for (const { file, command } of PYTHON_LOCKFILES) {
    if (existsSync(join(dirPath, file))) return command;
  }

  const pyproject = Bun.file(join(dirPath, "pyproject.toml"));
  if ((await pyproject.exists()) && TOOL_UV_TABLE.test(await pyproject.text())) return "uv sync";

  const requirements = requirementsFiles(dirPath);
  if (requirements.length === 0) return null;
  const args = requirements.map((file) => `-r ${file}`).join(" ");
  return Bun.which("uv", { PATH })
    ? `uv venv && uv pip install ${args}`
    : `python3 -m venv .venv && .venv/bin/pip install ${args}`;
}

/** Root `requirements*.txt` files, `requirements.txt` first. */
function requirementsFiles(dirPath: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dirPath);
  } catch {
    return [];
  }
  return names
    .filter((name) => REQUIREMENTS_FILE.test(name))
    .toSorted((a, b) => {
      if (a === "requirements.txt") return -1;
      if (b === "requirements.txt") return 1;
      return a.localeCompare(b);
    });
}
