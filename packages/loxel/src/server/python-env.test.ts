import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { pathOutsideWorktree, resolvePythonEnv, watchPythonEnv } from "./python-env";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function makeRoot(): Promise<{ wt: string; outside: string; bin: string }> {
  root = await realpath(await mkdtemp(join(tmpdir(), "python-env-")));
  const wt = join(root, "wt");
  const outside = join(root, "outside");
  const bin = join(root, "bin");
  await Promise.all([mkdir(wt), mkdir(outside), mkdir(bin)]);
  return { wt, outside, bin };
}

async function writeExecutable(filePath: string, script = "#!/bin/sh\n"): Promise<string> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, script);
  await chmod(filePath, 0o755);
  return filePath;
}

/** A venv-shaped directory: `pyvenv.cfg` plus an executable `bin/python`. */
async function makeVenv(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "pyvenv.cfg"), "home = /usr/bin\n");
  return writeExecutable(join(dir, "bin", "python"));
}

describe("resolvePythonEnv", () => {
  test("an executable override wins over everything else", async () => {
    const { wt, bin } = await makeRoot();
    await makeVenv(join(wt, ".venv"));
    const override = await makeVenv(join(root!, "picked"));
    await writeExecutable(join(bin, "python3"));

    const env = await resolvePythonEnv(wt, { overridePath: override, env: { PATH: bin } });
    expect(env).toEqual({
      source: "override",
      pythonPath: override,
      envPath: join(root!, "picked"),
    });
  });

  test("a missing override falls through to detection", async () => {
    const { wt } = await makeRoot();
    const python = await makeVenv(join(wt, ".venv"));

    const env = await resolvePythonEnv(wt, {
      overridePath: join(root!, "gone", "python"),
      env: { PATH: "" },
    });
    expect(env?.source).toBe("venv");
    expect(env?.pythonPath).toBe(python);
  });

  test("VIRTUAL_ENV is used only when it lies inside the worktree", async () => {
    const { wt, outside } = await makeRoot();
    await makeVenv(join(wt, ".venv"));
    const inside = await makeVenv(join(wt, "envs", "dev"));
    await makeVenv(join(outside, "venv"));

    const insideEnv = await resolvePythonEnv(wt, {
      env: { PATH: "", VIRTUAL_ENV: join(wt, "envs", "dev") },
    });
    expect(insideEnv).toEqual({
      source: "virtual-env",
      pythonPath: inside,
      envPath: join(wt, "envs", "dev"),
    });

    const outsideEnv = await resolvePythonEnv(wt, {
      env: { PATH: "", VIRTUAL_ENV: join(outside, "venv") },
    });
    expect(outsideEnv?.source).toBe("venv");
    expect(outsideEnv?.envPath).toBe(join(wt, ".venv"));
  });

  test("prefers .venv, then venv, then env", async () => {
    const { wt } = await makeRoot();
    await makeVenv(join(wt, "env"));
    expect((await resolvePythonEnv(wt, { env: { PATH: "" } }))?.envPath).toBe(join(wt, "env"));
    await makeVenv(join(wt, "venv"));
    expect((await resolvePythonEnv(wt, { env: { PATH: "" } }))?.envPath).toBe(join(wt, "venv"));
    await makeVenv(join(wt, ".venv"));
    expect((await resolvePythonEnv(wt, { env: { PATH: "" } }))?.envPath).toBe(join(wt, ".venv"));
  });

  test("ignores directories without pyvenv.cfg and venvs whose interpreter is gone", async () => {
    const { wt, bin } = await makeRoot();
    // An `env/` source directory that merely contains a `bin/python` file.
    await writeExecutable(join(wt, "env", "bin", "python"));
    // A venv whose base interpreter was uninstalled: the symlink dangles.
    await mkdir(join(wt, ".venv", "bin"), { recursive: true });
    await writeFile(join(wt, ".venv", "pyvenv.cfg"), "home = /nowhere\n");
    await symlink(join(root!, "removed-python"), join(wt, ".venv", "bin", "python"));
    const system = await writeExecutable(join(bin, "python3"));

    const env = await resolvePythonEnv(wt, { env: { PATH: bin } });
    expect(env).toEqual({ source: "system", pythonPath: system, envPath: null });
  });

  test("skips an interpreter the repository tracks", async () => {
    const { wt, bin } = await makeRoot();
    await makeVenv(join(wt, ".venv"));
    const git = (...args: string[]) => Bun.spawnSync(["git", "-C", wt, ...args]);
    git("init", "-q");
    git("add", ".venv");
    const system = await writeExecutable(join(bin, "python3"));

    expect(await resolvePythonEnv(wt, { env: { PATH: bin } })).toEqual({
      source: "system",
      pythonPath: system,
      envPath: null,
    });
  });

  test("skips an interpreter tracked by a nested repository or submodule", async () => {
    const { wt, bin } = await makeRoot();
    Bun.spawnSync(["git", "-C", wt, "init", "-q"]);
    await makeVenv(join(wt, ".venv"));
    // `.venv` is its own repository (as a submodule checkout is) that commits the interpreter.
    Bun.spawnSync(["git", "-C", join(wt, ".venv"), "init", "-q"]);
    Bun.spawnSync(["git", "-C", join(wt, ".venv"), "add", "bin/python"]);
    const system = await writeExecutable(join(bin, "python3"));

    expect((await resolvePythonEnv(wt, { env: { PATH: bin } }))?.pythonPath).toBe(system);
  });

  test("skips an interpreter git cannot vouch for inside a repository", async () => {
    const { wt, bin } = await makeRoot();
    Bun.spawnSync(["git", "-C", wt, "init", "-q"]);
    await makeVenv(join(wt, ".venv"));
    await writeFile(join(wt, ".venv", ".git"), "gitdir: /nonexistent\n");
    const system = await writeExecutable(join(bin, "python3"));

    expect((await resolvePythonEnv(wt, { env: { PATH: bin } }))?.pythonPath).toBe(system);
  });

  test("skips a tracked interpreter on PATH", async () => {
    const { wt, bin } = await makeRoot();
    Bun.spawnSync(["git", "-C", wt, "init", "-q"]);
    await writeExecutable(join(wt, "bin", "python3"));
    Bun.spawnSync(["git", "-C", wt, "add", "bin/python3"]);
    // Only `python3` further along PATH: the same name must still be found there.
    const python3 = await writeExecutable(join(bin, "python3"));

    const env = await resolvePythonEnv(wt, { env: { PATH: `${join(wt, "bin")}:${bin}` } });
    expect(env?.pythonPath).toBe(python3);
  });

  test("uses a .venv symlinked to an environment outside the worktree", async () => {
    const { wt, outside } = await makeRoot();
    Bun.spawnSync(["git", "-C", wt, "init", "-q"]);
    // Like a feature worktree sharing the main checkout's environment.
    Bun.spawnSync(["git", "-C", outside, "init", "-q"]);
    const shared = join(outside, ".venv");
    await makeVenv(shared);
    await symlink(shared, join(wt, ".venv"));

    const env = await resolvePythonEnv(wt, { env: { PATH: "" } });
    expect(env?.pythonPath).toBe(join(wt, ".venv", "bin", "python"));
  });

  test("uses an ignored virtual environment in a repository", async () => {
    const { wt } = await makeRoot();
    Bun.spawnSync(["git", "-C", wt, "init", "-q"]);
    await writeFile(join(wt, ".gitignore"), ".venv/\n");
    const python = await makeVenv(join(wt, ".venv"));

    expect((await resolvePythonEnv(wt, { env: { PATH: "" } }))?.pythonPath).toBe(python);
  });

  test("finds Pixi's default environment", async () => {
    const { wt } = await makeRoot();
    const python = await writeExecutable(join(wt, ".pixi", "envs", "default", "bin", "python"));

    const env = await resolvePythonEnv(wt, { env: { PATH: "" } });
    expect(env).toEqual({
      source: "pixi",
      pythonPath: python,
      envPath: join(wt, ".pixi", "envs", "default"),
    });
  });

  test("asks Poetry for its environment only when poetry.lock exists", async () => {
    const { wt, outside, bin } = await makeRoot();
    const poetryVenv = join(outside, "poetry-venv");
    const python = await makeVenv(poetryVenv);
    await writeExecutable(join(bin, "poetry"), `#!/bin/sh\necho "${poetryVenv}"\n`);
    const system = await writeExecutable(join(bin, "python3"));

    expect(await resolvePythonEnv(wt, { env: { PATH: bin } })).toEqual({
      source: "system",
      pythonPath: system,
      envPath: null,
    });

    await writeFile(join(wt, "poetry.lock"), "");
    expect(await resolvePythonEnv(wt, { env: { PATH: bin } })).toEqual({
      source: "poetry",
      pythonPath: python,
      envPath: poetryVenv,
    });
  });

  test("hides an activated environment from Poetry", async () => {
    const { wt, outside, bin } = await makeRoot();
    const active = join(outside, "active");
    await makeVenv(active);
    // Like Poetry, report the activated environment when there is one.
    await writeExecutable(
      join(bin, "poetry"),
      `#!/bin/sh\n[ -n "$VIRTUAL_ENV" ] || exit 1\necho "$VIRTUAL_ENV"\n`,
    );
    await writeFile(join(wt, "poetry.lock"), "");
    const system = await writeExecutable(join(bin, "python3"));

    const env = await resolvePythonEnv(wt, { env: { PATH: bin, VIRTUAL_ENV: active } });
    expect(env?.pythonPath).toBe(system);
  });

  test("falls back to python3, then python, on PATH, and to null", async () => {
    const { wt, bin } = await makeRoot();
    expect(await resolvePythonEnv(wt, { env: { PATH: bin } })).toBeNull();

    const python = await writeExecutable(join(bin, "python"));
    expect((await resolvePythonEnv(wt, { env: { PATH: bin } }))?.pythonPath).toBe(python);

    const python3 = await writeExecutable(join(bin, "python3"));
    expect((await resolvePythonEnv(wt, { env: { PATH: bin } }))?.pythonPath).toBe(python3);
  });
});

describe("pathOutsideWorktree", () => {
  test("drops the worktree's own directories and keeps the rest in order", () => {
    expect(pathOutsideWorktree("/wt/bin:/usr/bin:/wt:/wt-other/bin:bin:/opt/bin", "/wt")).toBe(
      "/usr/bin:/wt-other/bin:/opt/bin",
    );
  });
});

describe("watchPythonEnv", () => {
  async function changesWithin(
    wt: string,
    act: () => Promise<void>,
    timeoutMs = 1800,
  ): Promise<number> {
    let changes = 0;
    const watch = watchPythonEnv(wt, await resolvePythonEnv(wt, { env: { PATH: "" } }), () => {
      changes++;
    });
    try {
      // FSEvents can drop events from the first moments of a new watch.
      await Bun.sleep(300);
      await act();
      await Bun.sleep(timeoutMs);
      return changes;
    } finally {
      watch.close();
    }
  }

  test("reports a virtual environment appearing, debounced into one change", async () => {
    const { wt } = await makeRoot();
    expect(await changesWithin(wt, () => makeVenv(join(wt, ".venv")).then(() => {}))).toBe(1);
  });

  test("reports packages installed into the current environment", async () => {
    const { wt } = await makeRoot();
    await makeVenv(join(wt, ".venv"));
    const sitePackages = join(wt, ".venv", "lib", "python3.12", "site-packages");
    await mkdir(sitePackages, { recursive: true });

    const changes = await changesWithin(wt, () => mkdir(join(sitePackages, "requests")));
    expect(changes).toBe(1);
  });

  test("reports an interpreter landing in an environment's existing bin", async () => {
    const { wt } = await makeRoot();
    // Conda and Pixi create the prefix and its bin before the interpreter.
    await mkdir(join(wt, ".pixi", "envs", "default", "bin"), { recursive: true });

    const changes = await changesWithin(wt, () =>
      writeExecutable(join(wt, ".pixi", "envs", "default", "bin", "python")).then(() => {}),
    );
    expect(changes).toBe(1);
  });

  test("ignores unrelated files at the worktree root", async () => {
    const { wt } = await makeRoot();
    expect(await changesWithin(wt, () => writeFile(join(wt, "main.py"), "print(1)\n"))).toBe(0);
  });
});
