import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { PythonEnv } from "@/api/python-env-model";

const root = await realpath(await mkdtemp(join(tmpdir(), "loxel-terminal-python-env-")));
process.env.LOXEL_STATE_DIR = join(root, "state");
const { activatePythonEnv } = await import("./terminal-python-env");

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

/** A git worktree holding an untracked venv, as uv or `python -m venv` leave it. */
const wt = join(root, "wt");
const venvPath = join(wt, ".venv");
const venvBin = join(venvPath, "bin");
const venv: PythonEnv = { source: "venv", pythonPath: join(venvBin, "python"), envPath: venvPath };
await mkdir(venvBin, { recursive: true });
await writeFile(join(venvPath, "pyvenv.cfg"), "home = /usr/bin\n");
git(wt, "init", "-q");

const pixiPath = join(wt, ".pixi", "envs", "default");
const pixi: PythonEnv = {
  source: "pixi",
  pythonPath: join(pixiPath, "bin", "python"),
  envPath: pixiPath,
};
await mkdir(join(pixiPath, "bin"), { recursive: true });
await mkdir(join(pixiPath, "conda-meta"));

describe("activatePythonEnv", () => {
  test("exports what the venv's activate script would, moving its bin to the front", async () => {
    const env: Record<string, string | undefined> = {
      PATH: `/usr/bin:${venvBin}:/bin`,
      PYTHONHOME: "/opt/python",
      VIRTUAL_ENV_PROMPT: "(other)",
    };
    await activatePythonEnv(env, venv, "/bin/zsh", wt);
    expect(env).toMatchObject({ PATH: `${venvBin}:/usr/bin:/bin`, VIRTUAL_ENV: venvPath });
    expect(env.PYTHONHOME).toBeUndefined();
    expect(env.VIRTUAL_ENV_PROMPT).toBeUndefined();
  });

  test("does not claim a venv in shells without the shim, whose startup can reorder PATH", async () => {
    const env: Record<string, string | undefined> = { PATH: "/usr/bin", VIRTUAL_ENV: "/elsewhere" };
    await activatePythonEnv(env, venv, "/opt/homebrew/bin/fish", wt);
    expect(env).toEqual({ PATH: `${venvBin}:/usr/bin` });
  });

  test("puts a conda-style environment on PATH without claiming it is a venv", async () => {
    const env: Record<string, string | undefined> = { PATH: "/usr/bin", VIRTUAL_ENV: "/elsewhere" };
    await activatePythonEnv(env, pixi, "/bin/bash", wt);
    expect(env).toEqual({ PATH: `${join(pixiPath, "bin")}:/usr/bin` });
  });

  test("leaves the environment alone for an interpreter outside any environment", async () => {
    const env = { PATH: "/usr/bin" };
    const system: PythonEnv = { source: "system", pythonPath: "/usr/bin/python3", envPath: null };
    await activatePythonEnv(env, system, "/bin/zsh", wt);
    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  test("refuses a bin holding files the repository tracks", async () => {
    const repo = join(root, "tracked");
    const bin = join(repo, ".venv", "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(repo, ".gitignore"), ".venv/\n");
    await writeFile(join(bin, "git"), "#!/bin/sh\n");
    git(repo, "init", "-q");
    git(repo, "add", "-f", ".gitignore", ".venv/bin/git");

    const env = { PATH: "/usr/bin" };
    await activatePythonEnv(
      env,
      { source: "venv", pythonPath: join(bin, "python"), envPath: join(repo, ".venv") },
      "/bin/bash",
      repo,
    );
    expect(env).toEqual({ PATH: "/usr/bin" });
  });
});

describe.skipIf(!Bun.which("zsh"))("zsh startup shim", () => {
  interface StartOptions {
    /** The user's startup files, in `$HOME` unless `zdotdir` is set. */
    files: Record<string, string>;
    pythonEnv?: PythonEnv;
    /** Inherit `ZDOTDIR` pointing at a separate directory holding `files`. */
    zdotdir?: boolean;
  }

  /** Start a login zsh with the given user startup files, and report what it ended up with. */
  async function startZsh(options: StartOptions): Promise<Record<string, string>> {
    const home = await mkdtemp(join(root, "home-"));
    const userDir = options.zdotdir ? await mkdtemp(join(root, "zdotdir-")) : home;
    for (const [name, content] of Object.entries(options.files)) {
      await mkdir(dirname(join(userDir, name)), { recursive: true });
      await writeFile(join(userDir, name), content.replaceAll("$TEST_DIR", userDir));
    }
    const env: Record<string, string | undefined> = { ...process.env, HOME: home };
    if (options.zdotdir) env.ZDOTDIR = userDir;
    else delete env.ZDOTDIR;
    await activatePythonEnv(env, options.pythonEnv ?? venv, "/bin/zsh", wt);

    // Written to work under whatever options the user's files set (no_unset, ksh_arrays).
    const report = [
      'print -r -- "first=${PATH%%:*}"',
      'print -r -- "path=$PATH"',
      'print -r -- "zdotdir=${ZDOTDIR-unset} ${(t)ZDOTDIR-}"',
      'print -r -- "histfile=${HISTFILE-}"',
      'print -r -- "leaked=${LOXEL_PYTHON_ENV_BIN-}${LOXEL_USER_ZDOTDIR-}${_loxel_zdotdir-}"',
      'print -r -- "seen=${SEEN-}"',
    ].join("; ");
    const proc = Bun.spawn(["zsh", "-il", "-c", report], {
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    const result: Record<string, string> = { home, userDir, stderr };
    for (const line of stdout.split("\n")) {
      const at = line.indexOf("=");
      if (at > 0) result[line.slice(0, at)] = line.slice(at + 1);
    }
    return result;
  }

  test("runs the user's startup files, then keeps the environment first on PATH", async () => {
    const result = await startZsh({
      files: {
        ".zshenv": 'SEEN="env:$ZDOTDIR"\n',
        // What macOS path_helper and Homebrew's shellenv do to an inherited PATH.
        ".zprofile": 'path=(/usr/bin /bin $path); SEEN="$SEEN profile"\n',
        ".zshrc": 'SEEN="$SEEN rc"\n',
        ".zlogin": 'SEEN="$SEEN login"\n',
      },
    });
    expect(result.first).toBe(venvBin);
    expect(result.seen).toBe(`env:${result.home} profile rc login`);
    expect(result.zdotdir).toBe("unset ");
    expect(result.histfile?.startsWith(join(root, "state"))).toBe(false);
    expect(result.leaked).toBe("");
  });

  test("follows an inherited ZDOTDIR, and one the user's .zshenv sets without exporting", async () => {
    const inherited = await startZsh({ zdotdir: true, files: { ".zshrc": "SEEN=rc\n" } });
    expect(inherited.seen).toBe("rc");
    expect(inherited.zdotdir).toBe(`${inherited.userDir} scalar-export`);

    const custom = await startZsh({
      files: { ".zshenv": "ZDOTDIR=$TEST_DIR/zsh\n", "zsh/.zshrc": "SEEN=custom-rc\n" },
    });
    expect(custom.seen).toBe("custom-rc");
    expect(custom.zdotdir).toBe(`${custom.home}/zsh scalar`);
    expect(custom.first).toBe(venvBin);
  });

  test("works under the user's no_unset and ksh_arrays", async () => {
    const result = await startZsh({
      pythonEnv: pixi,
      files: { ".zshenv": "setopt no_unset\n", ".zshrc": 'setopt ksh_arrays; SEEN="rc"\n' },
    });
    expect(result.seen).toBe("rc");
    expect(result.first).toBe(join(pixiPath, "bin"));
    expect(result.path?.split(":")).toContain("/usr/bin");
    expect(result.leaked).toBe("");
    // macOS /etc/zshrc itself trips over no_unset; only the shim's own files must not.
    expect(result.stderr).not.toContain("zsh-python-env");
  });

  test("moves rather than duplicates a directory whose name holds pattern characters", async () => {
    const odd = join(root, "Projects (work) [1]*", ".venv");
    await mkdir(join(odd, "bin"), { recursive: true });
    await writeFile(join(odd, "pyvenv.cfg"), "home = /usr/bin\n");
    const oddBin = join(odd, "bin");
    const result = await startZsh({
      pythonEnv: { source: "venv", pythonPath: join(oddBin, "python"), envPath: odd },
      files: { ".zshrc": "setopt glob_subst; path=(/usr/bin /bin $path)\n" },
    });
    expect(result.first).toBe(oddBin);
    expect(result.path?.split(":").filter((dir) => dir === oddBin)).toHaveLength(1);
  });

  test("leaves a virtual environment the user's startup files activated in front", async () => {
    const result = await startZsh({
      files: { ".zshrc": "export VIRTUAL_ENV=/other/venv; path=(/other/venv/bin $path)\n" },
    });
    expect(result.first).toBe("/other/venv/bin");
  });
});
