/**
 * Python environment activation for terminal shells: environment variables only (what a venv's
 * `activate` script exports), plus a zsh startup shim that re-applies the PATH entry after the
 * user's own startup files. See docs/TERMINALS.md.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { PythonEnv } from "@/api/python-env-model";

import { config } from "./config";

/**
 * Login shells reorder PATH after spawn (macOS `path_helper` in /etc/zprofile puts the system
 * directories first, Homebrew's `shellenv` prepends its own), which would push the environment's
 * `bin` behind `/usr/bin`. zsh reads its startup files from `$ZDOTDIR`, so these wrappers stand in
 * for them: each sources the user's file with the user's `ZDOTDIR` restored, and the last one
 * (`.zlogin`) puts `$LOXEL_PYTHON_ENV_BIN` back in front, unless the user's files activated a
 * different virtual environment, then hands `ZDOTDIR` back.
 */
const ZSH_SHIM_FILES: Record<string, string> = {
  ".zshenv": `_loxel_zdotdir="$ZDOTDIR"
ZDOTDIR="\${LOXEL_USER_ZDOTDIR:-$HOME}"
if [[ -f "$ZDOTDIR/.zshenv" ]]; then source "$ZDOTDIR/.zshenv"; fi
LOXEL_USER_ZDOTDIR="$ZDOTDIR"
ZDOTDIR="$_loxel_zdotdir"
`,
  ".zprofile": `ZDOTDIR="$LOXEL_USER_ZDOTDIR"
if [[ -f "$ZDOTDIR/.zprofile" ]]; then source "$ZDOTDIR/.zprofile"; fi
LOXEL_USER_ZDOTDIR="$ZDOTDIR"
ZDOTDIR="$_loxel_zdotdir"
`,
  ".zshrc": `# /etc/zshrc derives HISTFILE from ZDOTDIR, which still pointed here.
if [[ "$HISTFILE" == "$_loxel_zdotdir/.zsh_history" ]]; then
  HISTFILE="$LOXEL_USER_ZDOTDIR/.zsh_history"
fi
ZDOTDIR="$LOXEL_USER_ZDOTDIR"
if [[ -f "$ZDOTDIR/.zshrc" ]]; then source "$ZDOTDIR/.zshrc"; fi
LOXEL_USER_ZDOTDIR="$ZDOTDIR"
ZDOTDIR="$_loxel_zdotdir"
`,
  ".zlogin": `ZDOTDIR="$LOXEL_USER_ZDOTDIR"
if [[ -f "$ZDOTDIR/.zlogin" ]]; then source "$ZDOTDIR/.zlogin"; fi
if [[ "$ZDOTDIR" == "$HOME" ]]; then unset ZDOTDIR; fi
if [[ -n "$LOXEL_PYTHON_ENV_BIN" ]] &&
  [[ -z "$VIRTUAL_ENV" || "$VIRTUAL_ENV" == "\${LOXEL_PYTHON_ENV_BIN:h}" ]]; then
  path=("$LOXEL_PYTHON_ENV_BIN" "\${(@)path:#\${(b)LOXEL_PYTHON_ENV_BIN}}")
fi
unset LOXEL_USER_ZDOTDIR LOXEL_PYTHON_ENV_BIN _loxel_zdotdir
`,
};

const SHIM_HEADER =
  "# Written by Loxel for terminals that activate a Python environment; do not edit.\n";

let zshShimDir: string | null = null;

/** Write the zsh shim once per server process (it may change between versions) and return its directory. */
function ensureZshShim(): string {
  if (zshShimDir) return zshShimDir;
  const dir = path.join(config.stateDir, "zsh-python-env");
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(ZSH_SHIM_FILES)) {
    writeFileSync(path.join(dir, name), SHIM_HEADER + content);
  }
  zshShimDir = dir;
  return dir;
}

/**
 * Activate `pythonEnv` in a terminal's spawn environment the way its `activate` script would:
 * its `bin` first on PATH (moved, not duplicated, when already there), `VIRTUAL_ENV` for a venv,
 * and no `PYTHONHOME`. An interpreter outside any environment changes nothing. For zsh, also
 * routes startup through the shim that keeps the entry first after the user's startup files.
 */
export function activatePythonEnv(
  env: Record<string, string | undefined>,
  pythonEnv: PythonEnv,
  shell: string,
): void {
  if (!pythonEnv.envPath) return;
  const binDir = path.dirname(pythonEnv.pythonPath);
  const rest = (env.PATH ?? "").split(path.delimiter).filter((dir) => dir && dir !== binDir);
  env.PATH = [binDir, ...rest].join(path.delimiter);
  delete env.PYTHONHOME;
  // An environment inherited from wherever Loxel was launched no longer applies.
  delete env.VIRTUAL_ENV_PROMPT;
  if (existsSync(path.join(pythonEnv.envPath, "pyvenv.cfg"))) env.VIRTUAL_ENV = pythonEnv.envPath;
  else delete env.VIRTUAL_ENV;

  if (path.basename(shell) !== "zsh") return;
  if (env.ZDOTDIR) env.LOXEL_USER_ZDOTDIR = env.ZDOTDIR;
  else delete env.LOXEL_USER_ZDOTDIR;
  env.LOXEL_PYTHON_ENV_BIN = binDir;
  env.ZDOTDIR = ensureZshShim();
}
