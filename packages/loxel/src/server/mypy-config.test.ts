import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { coversFile, findMypyConfig, iniSection, isMypyConfigFile } from "./mypy-config";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function makeWorktree(files: Record<string, string>): Promise<string> {
  root = await realpath(await mkdtemp(join(tmpdir(), "mypy-config-")));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(root, name, ".."), { recursive: true });
    await writeFile(join(root, name), content);
  }
  return root;
}

describe("findMypyConfig", () => {
  test("finds [tool.mypy] in the root pyproject.toml, with its targets", async () => {
    const wt = await makeWorktree({
      "pyproject.toml": '[tool.mypy]\nstrict = true\nfiles = ["src"]\n',
    });
    expect(findMypyConfig(join(wt, "src", "pkg", "mod.py"), wt)).toEqual({
      dir: wt,
      file: join(wt, "pyproject.toml"),
      hasTargets: true,
      files: ["src"],
    });
  });

  test("skips a pyproject.toml or setup.cfg without a mypy section, as mypy does", async () => {
    const wt = await makeWorktree({
      "pyproject.toml": "[tool.ruff]\nline-length = 100\n",
      "setup.cfg": "[flake8]\nmax-line-length = 100\n",
      "app/pyproject.toml": "[project]\nname = 'app'\n",
    });
    expect(findMypyConfig(join(wt, "app", "main.py"), wt)).toBeNull();
  });

  test("takes the nearest config, so subprojects get their own", async () => {
    const wt = await makeWorktree({
      "pyproject.toml": "[tool.mypy]\n",
      "services/api/setup.cfg": "[metadata]\nname = api\n\n[mypy]\nfiles = api\n",
    });
    expect(findMypyConfig(join(wt, "services", "api", "api", "app.py"), wt)).toEqual({
      dir: join(wt, "services", "api"),
      file: join(wt, "services", "api", "setup.cfg"),
      hasTargets: true,
      files: ["api"],
    });
    expect(findMypyConfig(join(wt, "tools", "x.py"), wt)?.dir).toBe(wt);
  });

  test("prefers mypy.ini over pyproject.toml in the same directory, even without [mypy]", async () => {
    const wt = await makeWorktree({
      "mypy.ini": "# empty\n",
      "pyproject.toml": "[tool.mypy]\nfiles = ['src']\n",
    });
    expect(findMypyConfig(join(wt, "main.py"), wt)).toEqual({
      dir: wt,
      file: join(wt, "mypy.ini"),
      hasTargets: false,
      files: null,
    });
  });

  test("still finds a pyproject.toml broken mid-edit that has [tool.mypy]", async () => {
    const wt = await makeWorktree({ "pyproject.toml": "[tool.mypy]\nstrict = maybe\n" });
    expect(findMypyConfig(join(wt, "main.py"), wt)?.file).toBe(join(wt, "pyproject.toml"));
  });

  test("sees a config file change", async () => {
    const wt = await makeWorktree({ "pyproject.toml": "[project]\nname = 'x'\n" });
    expect(findMypyConfig(join(wt, "main.py"), wt)).toBeNull();
    await writeFile(join(wt, "pyproject.toml"), "[project]\nname = 'x'\n\n[tool.mypy]\n");
    expect(findMypyConfig(join(wt, "main.py"), wt)?.dir).toBe(wt);
  });

  test("ignores files outside the worktree", async () => {
    const wt = await makeWorktree({ "pyproject.toml": "[tool.mypy]\n" });
    expect(findMypyConfig("/elsewhere/main.py", wt)).toBeNull();
  });
});

describe("iniSection", () => {
  test("reads a section's values, skipping comments and joining continuation lines", () => {
    const text = [
      "[metadata]",
      "files = nope",
      "[mypy]",
      "# files = commented",
      "strict: True",
      "packages =",
      "    a",
      "    b",
      "[mypy-tests.*]",
      "ignore_errors = True",
    ].join("\n");
    expect(iniSection(text, "mypy")).toEqual(
      new Map([
        ["strict", "True"],
        ["packages", "a b"],
      ]),
    );
    expect(iniSection(text, "tool")).toBeNull();
  });
});

test("coversFile follows the config's files entries: paths, directories and globs", () => {
  const config = {
    dir: "/wt",
    file: "/wt/setup.cfg",
    hasTargets: true,
    files: ["src", "scripts/*.py", "tools/run.py"],
  };
  expect(coversFile(config, "/wt/src/pkg/mod.py")).toBe(true);
  expect(coversFile(config, "/wt/scripts/build.py")).toBe(true);
  expect(coversFile(config, "/wt/tools/run.py")).toBe(true);
  expect(coversFile(config, "/wt/tests/test_mod.py")).toBe(false);
  expect(coversFile(config, "/wt/srcx/mod.py")).toBe(false);
  expect(coversFile({ ...config, files: null }, "/wt/tests/test_mod.py")).toBe(true);
});

test("isMypyConfigFile", () => {
  expect(isMypyConfigFile("/wt/sub/setup.cfg")).toBe(true);
  expect(isMypyConfigFile("/wt/.mypy.ini")).toBe(true);
  expect(isMypyConfigFile("/wt/ruff.toml")).toBe(false);
});
