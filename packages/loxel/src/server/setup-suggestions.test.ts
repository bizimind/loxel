import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scanSetupSuggestions } from "./setup-suggestions";

let root: string;
/** PATH with a `uv` on it. */
let uvPath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "loxel-setup-suggestions-"));
  uvPath = join(root, "bin");
  await mkdir(uvPath);
  await writeFile(join(uvPath, "uv"), "#!/bin/sh\n");
  await chmod(join(uvPath, "uv"), 0o755);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function project(files: Record<string, string>): Promise<string> {
  const dir = join(root, "project");
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
  return dir;
}

describe("scanSetupSuggestions", () => {
  test("suggests the install for each Python lockfile, the first one found winning", async () => {
    const cases: Array<[string, string]> = [
      ["uv.lock", "uv sync"],
      ["poetry.lock", "poetry install"],
      ["pdm.lock", "pdm install"],
      ["Pipfile.lock", "pipenv install --dev"],
    ];
    for (const [file, command] of cases) {
      await rm(join(root, "project"), { recursive: true, force: true });
      const dir = await project({ [file]: "", "requirements.txt": "" });
      expect((await scanSetupSuggestions(dir, "")).commands).toEqual([command]);
    }

    const both = await project({ "uv.lock": "", "poetry.lock": "" });
    expect((await scanSetupSuggestions(both, "")).commands).toEqual(["uv sync"]);
  });

  test("suggests uv sync for a uv project without a lockfile", async () => {
    const workspace = await project({ "pyproject.toml": "[project]\n\n[tool.uv.workspace]\n" });
    expect((await scanSetupSuggestions(workspace, "")).commands).toEqual(["uv sync"]);

    await writeFile(join(workspace, "pyproject.toml"), "[tool.uvicorn]\n[tool.ruff]\n");
    expect((await scanSetupSuggestions(workspace, "")).commands).toEqual([]);
  });

  test("creates a venv from the requirements files, with uv when it is installed", async () => {
    const dir = await project({
      "requirements-dev.txt": "",
      "requirements.txt": "",
      "requirements docs.txt": "",
    });
    expect((await scanSetupSuggestions(dir, uvPath)).commands).toEqual([
      "uv venv && uv pip install -r requirements.txt -r requirements-dev.txt",
    ]);
    expect((await scanSetupSuggestions(dir, join(root, "empty"))).commands).toEqual([
      "python3 -m venv .venv && .venv/bin/pip install -r requirements.txt -r requirements-dev.txt",
    ]);
  });

  test("keeps the existing suggestions alongside the Python one", async () => {
    const dir = await project({ "pnpm-lock.yaml": "", ".envrc": "", "uv.lock": "" });
    expect(await scanSetupSuggestions(dir, "")).toEqual({
      files: [".envrc"],
      commands: ["pnpm i --frozen-lockfile", "direnv allow", "uv sync"],
    });
  });
});
