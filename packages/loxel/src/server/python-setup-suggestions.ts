/** The Python command workspace setup suggests for a project directory. */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

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
 * The command that creates a worktree's Python environment: the project manager's install for its
 * lockfile, `uv sync` for a uv project without a lockfile, else a `.venv` with the root
 * `requirements*.txt` files installed. The environment is created per worktree, never shared:
 * venvs embed absolute paths, and editable installs point at one checkout.
 */
export async function pythonSetupCommands(dirPath: string, PATH: string): Promise<string[]> {
  for (const { file, command } of PYTHON_LOCKFILES) {
    if (existsSync(join(dirPath, file))) return [command];
  }

  const pyproject = Bun.file(join(dirPath, "pyproject.toml"));
  if ((await pyproject.exists()) && TOOL_UV_TABLE.test(await pyproject.text())) return ["uv sync"];

  const requirements = requirementsFiles(dirPath);
  if (requirements.length === 0) return [];
  const args = requirements.map((file) => `-r ${file}`).join(" ");
  return [
    Bun.which("uv", { PATH })
      ? `uv venv && uv pip install ${args}`
      : `python3 -m venv .venv && .venv/bin/pip install ${args}`,
  ];
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
