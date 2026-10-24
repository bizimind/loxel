import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Interpreter overrides live in the store database; keep the tests' state out of the real one.
const stateDir = await mkdtemp(join(tmpdir(), "python-env-state-"));
process.env.LOXEL_STATE_DIR = stateDir;
const { listPythonEnvs, normalizePythonOverride, resolvePythonEnv, watchPythonEnv } =
  await import("./python-env");
const { getPythonOverride, onPythonOverrideChange, setPythonOverride } =
  await import("./python-override-store");

let root: string | undefined;

afterAll(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

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

  test("uses the override chosen for the worktree unless told not to", async () => {
    const { wt } = await makeRoot();
    const venvPython = await makeVenv(join(wt, ".venv"));
    const picked = await makeVenv(join(root!, "picked"));
    setPythonOverride(wt, picked);

    expect(await resolvePythonEnv(wt, { env: { PATH: "" } })).toEqual({
      source: "override",
      pythonPath: picked,
      envPath: join(root!, "picked"),
    });
    const automatic = await resolvePythonEnv(wt, { overridePath: null, env: { PATH: "" } });
    expect(automatic?.pythonPath).toBe(venvPython);

    setPythonOverride(wt, null);
    expect((await resolvePythonEnv(wt, { env: { PATH: "" } }))?.pythonPath).toBe(venvPython);
  });

  test("skips an override the repository tracks", async () => {
    const { wt, bin } = await makeRoot();
    const tracked = await makeVenv(join(wt, "committed"));
    const git = (...args: string[]) => Bun.spawnSync(["git", "-C", wt, ...args]);
    git("init", "-q");
    git("add", "committed");
    const system = await writeExecutable(join(bin, "python3"));

    const env = await resolvePythonEnv(wt, { overridePath: tracked, env: { PATH: bin } });
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

describe("python override store", () => {
  test("persists one override per worktree and reports changes", async () => {
    const { wt } = await makeRoot();
    const other = join(root!, "other");
    const changed: string[] = [];
    const unsubscribe = onPythonOverrideChange((path) => changed.push(path));

    setPythonOverride(wt, "/opt/python/bin/python3");
    expect(getPythonOverride(wt)).toBe("/opt/python/bin/python3");
    // The same worktree spelled with a trailing slash shares the override.
    expect(getPythonOverride(`${wt}/`)).toBe("/opt/python/bin/python3");
    expect(getPythonOverride(other)).toBeNull();

    setPythonOverride(wt, null);
    expect(getPythonOverride(wt)).toBeNull();
    unsubscribe();
    setPythonOverride(wt, "/ignored");
    expect(changed).toEqual([wt, wt]);
    setPythonOverride(wt, null);
  });
});

describe("listPythonEnvs", () => {
  test("lists root and nested environments, Pixi, and the system interpreter once each", async () => {
    const { wt, bin } = await makeRoot();
    Bun.spawnSync(["git", "-C", wt, "init", "-q"]);
    const rootVenv = await makeVenv(join(wt, ".venv"));
    await mkdir(join(wt, "services", "api"), { recursive: true });
    await writeFile(join(wt, "services", "api", "pyproject.toml"), "[project]\nname = 'api'\n");
    const nested = await makeVenv(join(wt, "services", "api", "venv"));
    // Not a project directory: no marker file, so its venv is not looked for.
    await makeVenv(join(wt, "scratch", ".venv"));
    const pixi = await writeExecutable(join(wt, ".pixi", "envs", "test", "bin", "python"));
    const system = await writeExecutable(join(bin, "python3"));

    const envs = await listPythonEnvs(wt, { env: { PATH: bin } });
    expect(envs.map((e) => e.pythonPath)).toEqual([rootVenv, pixi, nested, system]);
    expect(envs.map((e) => e.source)).toEqual(["venv", "pixi", "venv", "system"]);
  });

  test("leaves out environments the repository tracks", async () => {
    const { wt } = await makeRoot();
    await mkdir(join(wt, "lib"), { recursive: true });
    await writeFile(join(wt, "lib", "setup.py"), "");
    await makeVenv(join(wt, "lib", ".venv"));
    const git = (...args: string[]) => Bun.spawnSync(["git", "-C", wt, ...args]);
    git("init", "-q");
    git("add", "lib");

    expect(await listPythonEnvs(wt, { env: { PATH: "" } })).toEqual([]);
  });
});

describe("normalizePythonOverride", () => {
  test("accepts an interpreter or an environment directory", async () => {
    const { wt } = await makeRoot();
    const python = await makeVenv(join(root!, "env"));
    expect(await normalizePythonOverride(wt, python)).toBe(python);
    expect(await normalizePythonOverride(wt, ` ${join(root!, "env")} `)).toBe(python);
  });

  test("rejects relative, missing, non-executable, and tracked interpreters", async () => {
    const { wt } = await makeRoot();
    await expect(normalizePythonOverride(wt, "venv/bin/python")).rejects.toThrow("absolute");
    await expect(normalizePythonOverride(wt, join(root!, "nope"))).rejects.toThrow(
      "No executable Python interpreter",
    );
    await writeFile(join(root!, "plain"), "");
    await expect(normalizePythonOverride(wt, join(root!, "plain"))).rejects.toThrow(
      "No executable Python interpreter",
    );

    const tracked = await makeVenv(join(wt, ".venv"));
    const git = (...args: string[]) => Bun.spawnSync(["git", "-C", wt, ...args]);
    git("init", "-q");
    git("add", ".venv");
    await expect(normalizePythonOverride(wt, tracked)).rejects.toThrow("tracks in git");
  });
});
