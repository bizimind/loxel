/**
 * Python environment activation for terminal shells: the environment variables (see
 * `python-env-activation.ts`), plus a zsh startup shim that re-applies the PATH entry after the
 * user's own startup files. See docs/TERMINALS.md.
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { PythonEnv } from "@/api/python-env-model";

import { config } from "./config";
import { pythonEnvActivation, setPythonEnvVars } from "./python-env-activation";

/**
 * Login shells reorder PATH after spawn (macOS `path_helper` in /etc/zprofile puts the system
 * directories first, Homebrew's `shellenv` prepends its own), which would push the environment's
 * `bin` behind `/usr/bin`. zsh reads its startup files from `$ZDOTDIR`, so these wrappers stand in
 * for them: each sources the user's file with the user's `ZDOTDIR` restored, and the last one
 * (`.zlogin`) puts `$LOXEL_PYTHON_ENV_BIN` back in front, unless the user's files activated a
 * different virtual environment, then hands `ZDOTDIR` back. The wrappers run with the user's
 * options in effect (`no_unset`, `ksh_arrays`, `glob_subst`, ...), so every expansion has a default and the
 * PATH logic runs under `emulate -L zsh`; the `source` calls stay at top level so the user's
 * `typeset`s remain global.
 */
const ZSH_SHIM_FILES: Record<string, string> = {
  ".zshenv": `_loxel_zdotdir="\${ZDOTDIR-}"
# Without an inherited ZDOTDIR the user's own files must see it unexported, as in a plain zsh.
if [[ -z "\${LOXEL_USER_ZDOTDIR+x}" ]]; then typeset +x ZDOTDIR; fi
ZDOTDIR="\${LOXEL_USER_ZDOTDIR:-$HOME}"
if [[ -f "$ZDOTDIR/.zshenv" ]]; then source "$ZDOTDIR/.zshenv"; fi
LOXEL_USER_ZDOTDIR="\${ZDOTDIR-$HOME}"
ZDOTDIR="$_loxel_zdotdir"
`,
  ".zprofile": `ZDOTDIR="\${LOXEL_USER_ZDOTDIR-$HOME}"
if [[ -f "$ZDOTDIR/.zprofile" ]]; then source "$ZDOTDIR/.zprofile"; fi
LOXEL_USER_ZDOTDIR="\${ZDOTDIR-$HOME}"
ZDOTDIR="\${_loxel_zdotdir-}"
`,
  ".zshrc": `# /etc/zshrc derives HISTFILE from ZDOTDIR, which still pointed here.
if [[ "\${HISTFILE-}" == "\${_loxel_zdotdir-}/.zsh_history" ]]; then
  HISTFILE="\${LOXEL_USER_ZDOTDIR-$HOME}/.zsh_history"
fi
ZDOTDIR="\${LOXEL_USER_ZDOTDIR-$HOME}"
if [[ -f "$ZDOTDIR/.zshrc" ]]; then source "$ZDOTDIR/.zshrc"; fi
LOXEL_USER_ZDOTDIR="\${ZDOTDIR-$HOME}"
ZDOTDIR="\${_loxel_zdotdir-}"
`,
  ".zlogin": `ZDOTDIR="\${LOXEL_USER_ZDOTDIR-$HOME}"
if [[ -f "$ZDOTDIR/.zlogin" ]]; then source "$ZDOTDIR/.zlogin"; fi
() {
  emulate -L zsh
  if [[ "\${ZDOTDIR-}" == "$HOME" ]]; then unset ZDOTDIR; fi
  local bin="\${LOXEL_PYTHON_ENV_BIN-}"
  if [[ -n "$bin" ]] && [[ -z "\${VIRTUAL_ENV-}" || "\${VIRTUAL_ENV-}" == "\${bin:h}" ]]; then
    # Literal match: emulate turns glob_subst off, so $bin is not taken as a pattern.
    path=("$bin" "\${(@)path:#$bin}")
  fi
}
unset LOXEL_USER_ZDOTDIR LOXEL_PYTHON_ENV_BIN _loxel_zdotdir
`,
};

const SHIM_HEADER =
  "# Written by Loxel for terminals that activate a Python environment; do not edit.\n";

let zshShimWritten = false;

/**
 * The zsh shim's directory, written once per server process (it may change between versions) and
 * again if it went missing. Each file is replaced atomically, since a starting zsh may read it.
 */
function ensureZshShim(): string {
  const dir = path.join(config.stateDir, "zsh-python-env");
  if (zshShimWritten && existsSync(path.join(dir, ".zlogin"))) return dir;
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(ZSH_SHIM_FILES)) {
    const target = path.join(dir, name);
    const temp = `${target}.${process.pid}.tmp`;
    writeFileSync(temp, SHIM_HEADER + content);
    renameSync(temp, target);
  }
  zshShimWritten = true;
  return dir;
}

/**
 * Activate `pythonEnv` in a terminal's spawn environment the way its `activate` script would:
 * its `bin` first on PATH, `VIRTUAL_ENV` for a venv, and no `PYTHONHOME` (see
 * {@link setPythonEnvVars}). An interpreter outside any environment changes nothing, and so does
 * a `bin` that holds files git tracks in `worktreePath`. For zsh, routes
 * startup through the shim that keeps the entry first after the user's startup files; other shells
 * get the PATH entry without `VIRTUAL_ENV`, since their startup may move the entry back.
 */
export async function activatePythonEnv(
  env: Record<string, string | undefined>,
  pythonEnv: PythonEnv,
  shell: string,
  worktreePath: string,
): Promise<void> {
  if (!pythonEnv.envPath) return;
  const binDir = path.dirname(pythonEnv.pythonPath);
  const activation = await pythonEnvActivation(pythonEnv, worktreePath);
  if (!activation) return;
  // Before any change, so a failed write leaves the environment untouched.
  const shimDir = path.basename(shell) === "zsh" ? ensureZshShim() : null;

  // Only zsh gets the shim that keeps `bin` first. Other login shells can rebuild PATH with the
  // system directories ahead of it, and a VIRTUAL_ENV naming the venv (shown by prompts, honored
  // by uv and poetry) would then contradict the `python` and `pip` the shell runs.
  setPythonEnvVars(env, activation, { virtualEnv: shimDir !== null });

  if (!shimDir) return;
  // A ZDOTDIR that already is the shim (Loxel started from a shell mid-startup) would recurse.
  if (env.ZDOTDIR && env.ZDOTDIR !== shimDir) env.LOXEL_USER_ZDOTDIR = env.ZDOTDIR;
  else delete env.LOXEL_USER_ZDOTDIR;
  env.LOXEL_PYTHON_ENV_BIN = binDir;
  env.ZDOTDIR = shimDir;
}
