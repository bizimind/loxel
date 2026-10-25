import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PythonEnv } from "@/api/python-env-model";

const root = await mkdtemp(join(tmpdir(), "loxel-terminal-python-env-"));
process.env.LOXEL_STATE_DIR = join(root, "state");
const { activatePythonEnv } = await import("./terminal-python-env");

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const venvPath = join(root, "wt", ".venv");
const venvBin = join(venvPath, "bin");
const venv: PythonEnv = { source: "venv", pythonPath: join(venvBin, "python"), envPath: venvPath };
await mkdir(venvBin, { recursive: true });
await writeFile(join(venvPath, "pyvenv.cfg"), "home = /usr/bin\n");

describe("activatePythonEnv", () => {
  test("exports what the venv's activate script would, moving its bin to the front", () => {
    const env: Record<string, string | undefined> = {
      PATH: `/usr/bin:${venvBin}:/bin`,
      PYTHONHOME: "/opt/python",
      VIRTUAL_ENV_PROMPT: "(other)",
    };
    activatePythonEnv(env, venv, "/bin/bash");
    expect(env).toEqual({ PATH: `${venvBin}:/usr/bin:/bin`, VIRTUAL_ENV: venvPath });
  });

  test("puts a conda-style environment on PATH without claiming it is a venv", async () => {
    const pixiPath = join(root, "wt", ".pixi", "envs", "default");
    await mkdir(join(pixiPath, "conda-meta"), { recursive: true });
    const env: Record<string, string | undefined> = { PATH: "/usr/bin", VIRTUAL_ENV: "/elsewhere" };
    activatePythonEnv(
      env,
      { source: "pixi", pythonPath: join(pixiPath, "bin", "python"), envPath: pixiPath },
      "/bin/bash",
    );
    expect(env).toEqual({ PATH: `${join(pixiPath, "bin")}:/usr/bin` });
  });

  test("leaves the environment alone for an interpreter outside any environment", () => {
    const env = { PATH: "/usr/bin" };
    activatePythonEnv(
      env,
      { source: "system", pythonPath: "/usr/bin/python3", envPath: null },
      "/bin/zsh",
    );
    expect(env).toEqual({ PATH: "/usr/bin" });
  });
});

describe.skipIf(!Bun.which("zsh"))("zsh startup shim", () => {
  /** Start a login zsh whose own startup files live in `userZdotdir`, and print what it ended up with. */
  async function startZsh(userFiles: Record<string, string>): Promise<Record<string, string>> {
    const userZdotdir = await mkdtemp(join(root, "zdotdir-"));
    for (const [name, content] of Object.entries(userFiles)) {
      await writeFile(join(userZdotdir, name), content);
    }
    const env: Record<string, string | undefined> = { ...process.env, ZDOTDIR: userZdotdir };
    activatePythonEnv(env, venv, "/bin/zsh");
    const report = [
      'print -r -- "first=${path[1]}"',
      'print -r -- "zdotdir=${ZDOTDIR-unset}"',
      'print -r -- "histfile=$HISTFILE"',
      'print -r -- "leaked=${LOXEL_PYTHON_ENV_BIN-}${LOXEL_USER_ZDOTDIR-}${_loxel_zdotdir-}"',
      'print -r -- "seen=$SEEN"',
    ].join("; ");
    const proc = Bun.spawn(["zsh", "-il", "-c", report], {
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    const result: Record<string, string> = { userZdotdir };
    for (const line of stdout.split("\n")) {
      const at = line.indexOf("=");
      if (at > 0) result[line.slice(0, at)] = line.slice(at + 1);
    }
    return result;
  }

  test("runs the user's startup files, then keeps the environment first on PATH", async () => {
    const result = await startZsh({
      ".zshenv": 'SEEN="env:$ZDOTDIR"\n',
      // What macOS path_helper and Homebrew's shellenv do to an inherited PATH.
      ".zprofile": 'path=(/usr/bin /bin $path); SEEN="$SEEN profile"\n',
      ".zshrc": 'SEEN="$SEEN rc"\n',
      ".zlogin": 'SEEN="$SEEN login"\n',
    });
    expect(result.first).toBe(venvBin);
    expect(result.seen).toBe(`env:${result.userZdotdir} profile rc login`);
    expect(result.zdotdir).toBe(result.userZdotdir);
    expect(result.histfile?.startsWith(join(root, "state"))).toBe(false);
    expect(result.leaked).toBe("");
  });

  test("leaves a virtual environment the user's startup files activated in front", async () => {
    const result = await startZsh({
      ".zshrc": "export VIRTUAL_ENV=/other/venv; path=(/other/venv/bin $path)\n",
    });
    expect(result.first).toBe("/other/venv/bin");
  });
});
