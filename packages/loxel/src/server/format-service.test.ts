import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { $ } from "bun";

import { DEFAULT_FORMATTING_SETTINGS, type FormattingSettings } from "@/lib/formatting-model";

// Python files reach the shared environment resolution, which reads interpreter overrides from
// the store database; keep the tests' state out of the real one.
const stateDir = await mkdtemp(join(tmpdir(), "format-service-state-"));
process.env.LOXEL_STATE_DIR = stateDir;
const { FormatService } = await import("./format-service");
const { findVenvBin } = await import("./python-formatter");

afterAll(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function makeWorktree(files: Record<string, string>): Promise<string> {
  root = await mkdtemp(join(tmpdir(), "format-service-"));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content);
  }
  return root;
}

/** A fake formatter that echoes its arguments, so tests can tell which binary ran and how. */
const ECHO_ARGS_SCRIPT = '#!/bin/sh\necho "$(basename "$0") $*"\n';

/**
 * Install `script` as `<venvDir>/bin/<command>` in a venv marked by `pyvenv.cfg`. Each fake binary
 * is written once, executable from creation, and never rewritten: rewriting a script that was just
 * executed and running it again is racy on Linux (ETXTBSY), which made a test flaky in CI.
 */
async function makeFakeVenv(
  venvDir: string,
  command: string,
  script = ECHO_ARGS_SCRIPT,
): Promise<void> {
  const bin = join(venvDir, "bin", command);
  await mkdir(dirname(bin), { recursive: true });
  await writeFile(join(venvDir, "pyvenv.cfg"), "home = /usr/bin\n");
  await writeFile(bin, script, { mode: 0o755 });
}

const AUTO_DETECT: FormattingSettings = DEFAULT_FORMATTING_SETTINGS;

function findFormatter(service: InstanceType<typeof FormatService>, wt: string, command: string) {
  return service.getDetectedFormatters(wt).find((f) => f.command === command);
}

describe("FormatService auto-detection", () => {
  test("detects oxfmt from a devDependency and claims md (and other oxfmt-supported extensions)", async () => {
    const wt = await makeWorktree({
      "package.json": JSON.stringify({ devDependencies: { oxfmt: "0.68.0" } }),
    });
    const service = new FormatService();
    const detected = service.getDetectedFormatters(wt);
    expect(detected.map((f) => f.command)).toEqual(["oxfmt"]);

    const oxfmt = findFormatter(service, wt, "oxfmt");
    expect(oxfmt).toBeDefined();
    for (const ext of ["ts", "md", "json", "yaml", "toml", "html", "vue", "scss", "graphql"]) {
      expect(oxfmt!.extensions).toContain(ext);
    }
    // Not formatted by default in oxfmt 0.68 — must not be claimed.
    expect(oxfmt!.extensions).not.toContain("svelte");
    expect(oxfmt!.extensions).not.toContain("astro");
  });

  test("detects oxfmt from .oxfmtrc.jsonc without a package.json", async () => {
    const wt = await makeWorktree({ ".oxfmtrc.jsonc": "{}" });
    const service = new FormatService();
    expect(findFormatter(service, wt, "oxfmt")?.extensions).toContain("md");
  });

  test("lists prettier before oxfmt when both are detected (prettier wins for md)", async () => {
    // `format()` walks detected formatters in order and uses the first one whose extension set
    // contains the file's extension. Detection rules are ordered prettier → oxfmt, so a project
    // with both formatters keeps using prettier for shared extensions such as md/json.
    const wt = await makeWorktree({
      ".prettierrc": "{}",
      "package.json": JSON.stringify({ devDependencies: { oxfmt: "0.68.0", prettier: "3.0.0" } }),
    });
    const service = new FormatService();
    const detected = service.getDetectedFormatters(wt);
    expect(detected.map((f) => f.command)).toEqual(["prettier", "oxfmt"]);

    // Every extension oxfmt claims that prettier can also format must route to prettier, so
    // alias spellings (yml, mjs, scss, mdx, ...) do not silently diverge from the canonical ones.
    const oxfmt = findFormatter(service, wt, "oxfmt")!;
    const prettier = findFormatter(service, wt, "prettier")!;
    for (const ext of oxfmt.extensions) {
      const first = detected.find((f) => f.extensions.includes(ext));
      expect(first?.command, `first formatter for .${ext}`).toBe(
        ext === "toml" ? "oxfmt" : "prettier",
      );
    }
    expect(prettier.extensions).toContain("md");
  });

  test("detects nothing in an empty worktree", async () => {
    const wt = await makeWorktree({});
    const service = new FormatService();
    expect(service.getDetectedFormatters(wt)).toEqual([]);
  });
});

describe("FormatService Python detection", () => {
  const cases: { name: string; files: Record<string, string>; expected: string[] }[] = [
    { name: "ruff.toml", files: { "ruff.toml": "line-length = 100" }, expected: ["ruff"] },
    { name: ".ruff.toml", files: { ".ruff.toml": "" }, expected: ["ruff"] },
    {
      name: "pyproject.toml with [tool.ruff]",
      files: { "pyproject.toml": "[tool.ruff]\nline-length = 100" },
      expected: ["ruff"],
    },
    {
      name: "pyproject.toml with [tool.black]",
      files: { "pyproject.toml": "[tool.black]\nline-length = 100" },
      expected: ["black"],
    },
    {
      name: "[tool.black] next to a linter-only [tool.ruff]",
      files: { "pyproject.toml": "[tool.black]\n[tool.ruff.lint]\nselect = ['E']" },
      expected: ["black"],
    },
    {
      name: "[tool.black] next to [tool.ruff.format]",
      files: { "pyproject.toml": "[tool.black]\n[tool.ruff.format]\nquote-style = 'single'" },
      expected: ["ruff"],
    },
    {
      name: "ruff.toml with [format] next to [tool.black]",
      files: { "ruff.toml": "[format]\n", "pyproject.toml": "[tool.black]" },
      expected: ["ruff"],
    },
    {
      name: "bare pyproject.toml (no formatter config or dependency)",
      files: { "pyproject.toml": "[project]\nname = 'app'\ndependencies = ['requests']" },
      expected: [],
    },
    {
      name: "ruff in a PEP 735 dependency group",
      files: { "pyproject.toml": "[dependency-groups]\ndev = ['ruff>=0.6', 'pytest']" },
      expected: ["ruff"],
    },
    {
      name: "black in a Poetry dev group",
      files: { "pyproject.toml": "[tool.poetry.group.dev.dependencies]\nBlack = '^24'" },
      expected: ["black"],
    },
    {
      name: "both declared as dependencies (black formats, ruff lints)",
      files: { "pyproject.toml": "[project.optional-dependencies]\ndev = ['ruff', 'black==24.1']" },
      expected: ["black"],
    },
    {
      name: "a black dependency next to a linter-only [tool.ruff]",
      files: {
        "pyproject.toml":
          "[dependency-groups]\ndev = ['black>=24', 'ruff']\n[tool.ruff]\nline-length = 100",
      },
      expected: ["black"],
    },
    {
      name: "ruff in a Hatch environment",
      files: { "pyproject.toml": "[tool.hatch.envs.lint]\ndependencies = ['ruff']" },
      expected: ["ruff"],
    },
    { name: "unparsable pyproject.toml", files: { "pyproject.toml": "[tool.ruff" }, expected: [] },
  ];

  for (const { name, files, expected } of cases) {
    test(`root ${name} → ${expected.join(", ") || "nothing"}`, async () => {
      const wt = await makeWorktree(files);
      const detected = new FormatService().getDetectedFormatters(wt);
      expect(detected.map((f) => f.command)).toEqual(expected);
      for (const f of detected) expect(f.extensions).toEqual(["py", "pyi"]);
    });
  }

  test("formats .py and .pyi with ruff from the project venv, honoring ruff excludes", async () => {
    const wt = await makeWorktree({ "pyproject.toml": "[tool.ruff]" });
    await makeFakeVenv(join(wt, ".venv"), "ruff");
    const service = new FormatService();
    for (const file of ["app.py", "stubs/app.pyi"]) {
      const path = join(wt, file);
      const result = await service.format("x=1\n", path, wt, AUTO_DETECT);
      expect(result.content).toBe(`ruff format --force-exclude --stdin-filename ${path}\n`);
    }
  });

  test("formats with black from the nearest venv when black is configured", async () => {
    const wt = await makeWorktree({ "pyproject.toml": "[tool.black]" });
    await makeFakeVenv(join(wt, "venv"), "black");
    const path = join(wt, "app.py");
    const result = await new FormatService().format("x=1\n", path, wt, AUTO_DETECT);
    expect(result.content).toBe(`black --quiet --stdin-filename ${path} -\n`);
  });

  test("resolves a subproject's config and venv in a monorepo", async () => {
    // The root has no Python config, so only the per-file walk finds the subproject's ruff.
    const wt = await makeWorktree({
      "package.json": "{}",
      "services/api/pyproject.toml": "[tool.ruff]",
      "services/web/pyproject.toml": "[project]\nname = 'web'",
    });
    // The root venv's ruff prints a marker, so the echoed args below prove the subproject's own
    // venv won over the root one.
    await makeFakeVenv(join(wt, ".venv"), "ruff", "#!/bin/sh\necho root-venv\n");
    await makeFakeVenv(join(wt, "services/api/.venv"), "ruff");
    // A directory named like a venv without `pyvenv.cfg` is not a venv.
    await mkdir(join(wt, "services/api/pkg/.venv/bin"), { recursive: true });
    const service = new FormatService();
    expect(service.getDetectedFormatters(wt)).toEqual([]);

    const api = join(wt, "services/api/pkg/mod.py");
    const result = await service.format("x=1\n", api, wt, AUTO_DETECT);
    expect(result.content).toBe(`ruff format --force-exclude --stdin-filename ${api}\n`);

    const web = join(wt, "services/web/app.py");
    expect(await service.format("x=1\n", web, wt, AUTO_DETECT)).toEqual({ content: null });
  });

  test("the nearest formatting signal wins; linter-only ruff signals lose to black anywhere", async () => {
    const wt = await makeWorktree({
      "pyproject.toml": "[tool.ruff.format]\nquote-style = 'single'",
      "legacy/pyproject.toml": "[tool.black]",
      "lib/pyproject.toml": "[dependency-groups]\ndev = ['black']",
      "lib/sub/pyproject.toml": "[dependency-groups]\ndev = ['ruff']\n[tool.ruff.lint]",
      "..hidden/pyproject.toml": "[tool.black]",
    });
    await makeFakeVenv(join(wt, ".venv"), "ruff");
    await makeFakeVenv(join(wt, ".venv"), "black");
    const service = new FormatService();
    const formattedBy = async (file: string) => {
      const result = await service.format("x=1\n", join(wt, file), wt, AUTO_DETECT);
      return result.content?.split(" ")[0];
    };
    expect(await formattedBy("app.py")).toBe("ruff");
    expect(await formattedBy("legacy/app.py")).toBe("black");
    expect(await formattedBy("lib/sub/app.py")).toBe("black");
    // A directory whose name merely starts with ".." is still inside the worktree.
    expect(await formattedBy("..hidden/app.py")).toBe("black");
  });

  test("only uses venvs from the file's directory up to the worktree root", async () => {
    const wt = await makeWorktree({ "repo/pkg/app.py": "" });
    await makeFakeVenv(join(wt, ".venv"), "ruff");
    expect(await findVenvBin(join(wt, "repo/pkg"), join(wt, "repo"), "ruff")).toBeUndefined();
    await makeFakeVenv(join(wt, "repo/venv"), "ruff");
    expect(await findVenvBin(join(wt, "repo/pkg"), join(wt, "repo"), "ruff")).toBe(
      join(wt, "repo/venv/bin"),
    );
  });

  test("skips venvs with files tracked by git", async () => {
    const wt = await makeWorktree({ "pkg/app.py": "" });
    await $`git init -q ${wt}`.quiet();
    await makeFakeVenv(join(wt, ".venv"), "ruff");
    await makeFakeVenv(join(wt, "pkg/.venv"), "ruff");
    await $`git -C ${wt} add -- pkg/.venv/bin/ruff`.quiet();
    // The tracked subproject venv is skipped in favor of the untracked one above it.
    expect(await findVenvBin(join(wt, "pkg"), wt, "ruff")).toBe(join(wt, ".venv/bin"));
    // A venv the repository starts tracking is skipped from then on.
    await $`git -C ${wt} add -- .venv/pyvenv.cfg`.quiet();
    expect(await findVenvBin(join(wt, "pkg"), wt, "ruff")).toBeUndefined();
  });

  test("uses the worktree's resolved environment, below a sub-project's own venv", async () => {
    const wt = await makeWorktree({ "pkg/app.py": "", "other/app.py": "" });
    // A Pixi environment: no pyvenv.cfg, found only through the shared resolution.
    const pixi = join(wt, ".pixi/envs/default");
    await mkdir(join(pixi, "bin"), { recursive: true });
    await writeFile(join(pixi, "bin/python"), "#!/bin/sh\n", { mode: 0o755 });
    await writeFile(join(pixi, "bin/ruff"), ECHO_ARGS_SCRIPT, { mode: 0o755 });
    await makeFakeVenv(join(wt, "pkg/.venv"), "ruff");
    expect(await findVenvBin(join(wt, "other"), wt, "ruff")).toBe(join(pixi, "bin"));
    expect(await findVenvBin(join(wt, "pkg"), wt, "ruff")).toBe(join(wt, "pkg/.venv/bin"));
  });

  test("only uses venvs that have the formatter", async () => {
    const wt = await makeWorktree({ "pkg/app.py": "" });
    await makeFakeVenv(join(wt, ".venv"), "ruff");
    await makeFakeVenv(join(wt, "pkg/.venv"), "black");
    expect(await findVenvBin(join(wt, "pkg"), wt, "ruff")).toBe(join(wt, ".venv/bin"));
    expect(await findVenvBin(join(wt, "pkg"), wt, "black")).toBe(join(wt, "pkg/.venv/bin"));
  });

  test("skips a venv when git tracks any file in it, not only the formatter", async () => {
    const wt = await makeWorktree({ ".venv/lib/python3.12/site-packages/hook.pth": "" });
    await $`git init -q ${wt}`.quiet();
    await makeFakeVenv(join(wt, ".venv"), "ruff");
    await $`git -C ${wt} add -f -- .venv/lib`.quiet();
    expect(await findVenvBin(wt, wt, "ruff")).toBeUndefined();
  });

  test("asks the innermost repository, so venvs committed in nested repos are skipped", async () => {
    const wt = await makeWorktree({ "sub/pkg/app.py": "", "other/pkg/app.py": "" });
    await $`git init -q ${wt}`.quiet();
    await $`git init -q ${join(wt, "sub")}`.quiet();
    await $`git init -q ${join(wt, "other")}`.quiet();
    await makeFakeVenv(join(wt, ".venv"), "ruff");
    await makeFakeVenv(join(wt, "sub/.venv"), "ruff");
    await makeFakeVenv(join(wt, "other/.venv"), "ruff");
    // The worktree's repo lists nothing under sub/.venv; only the nested repo knows it tracks it.
    await $`git -C ${join(wt, "sub")} add -- .venv`.quiet();
    expect(await findVenvBin(join(wt, "sub/pkg"), wt, "ruff")).toBe(join(wt, ".venv/bin"));
    // An untracked venv in a nested repo is still used.
    expect(await findVenvBin(join(wt, "other/pkg"), wt, "ruff")).toBe(join(wt, "other/.venv/bin"));
  });

  test("skips a venv that is itself a repository tracking its files", async () => {
    const wt = await makeWorktree({ "app.py": "" });
    await $`git init -q ${wt}`.quiet();
    await makeFakeVenv(join(wt, ".venv"), "ruff");
    await $`git init -q ${join(wt, ".venv")}`.quiet();
    await $`git -C ${join(wt, ".venv")} add -- bin/ruff`.quiet();
    expect(await findVenvBin(wt, wt, "ruff")).toBeUndefined();
  });

  test("skips a symlinked venv whose target is tracked", async () => {
    const wt = await makeWorktree({ "app.py": "" });
    await $`git init -q ${wt}`.quiet();
    await makeFakeVenv(join(wt, "tools/env"), "ruff");
    await $`git -C ${wt} add -- tools/env`.quiet();
    await symlink(join(wt, "tools/env"), join(wt, ".venv"));
    expect(await findVenvBin(wt, wt, "ruff")).toBeUndefined();
  });

  test("skips a venv when git cannot tell whether it is tracked", async () => {
    const wt = await makeWorktree({ "sub/.git": "gitdir: /nonexistent\n" });
    await $`git init -q ${wt}`.quiet();
    await makeFakeVenv(join(wt, "sub/.venv"), "ruff");
    expect(await findVenvBin(join(wt, "sub"), wt, "ruff")).toBeUndefined();
  });

  test("accepts worktree-relative file paths", async () => {
    const wt = await makeWorktree({ "pkg/ruff.toml": "" });
    await makeFakeVenv(join(wt, "pkg/.venv"), "ruff");
    const result = await new FormatService().format("x=1\n", "pkg/app.py", wt, AUTO_DETECT);
    expect(result.content).toBe("ruff format --force-exclude --stdin-filename pkg/app.py\n");
  });
});

describe("FormatService failure notices", () => {
  test("reports a missing formatter binary", async () => {
    const wt = await makeWorktree({});
    const settings: FormattingSettings = {
      ...AUTO_DETECT,
      overrides: [{ id: "o1", extensions: "py", command: "loxel-missing-formatter", args: "" }],
    };
    const result = await new FormatService().format("x=1\n", join(wt, "a.py"), wt, settings);
    expect(result).toEqual({
      content: null,
      notice: 'Format on save skipped: "loxel-missing-formatter" is not installed.',
    });
  });

  test("reports a formatter that is found but cannot start", async () => {
    const wt = await makeWorktree({ "ruff.toml": "" });
    await makeFakeVenv(join(wt, ".venv"), "ruff", "#!/nonexistent/python3\n");
    const result = await new FormatService().format("x=1\n", join(wt, "a.py"), wt, AUTO_DETECT);
    expect(result).toEqual({
      content: null,
      notice:
        'Format on save skipped: "ruff" could not be started; its interpreter may be missing.',
    });
  });

  test("reports a formatter that is not a runnable file", async () => {
    const wt = await makeWorktree({ "ruff.toml": "" });
    // No shebang and no binary header: the kernel refuses to run it (ENOEXEC).
    await makeFakeVenv(join(wt, ".venv"), "ruff", "not a program\n");
    const result = await new FormatService().format("x=1\n", join(wt, "a.py"), wt, AUTO_DETECT);
    expect(result.content).toBeNull();
    expect(result.notice).toStartWith('Format on save skipped: "ruff" could not be started (');
  });

  test("does not report a formatter that exits non-zero (e.g. a syntax error)", async () => {
    const wt = await makeWorktree({ "ruff.toml": "" });
    await makeFakeVenv(join(wt, ".venv"), "ruff", "#!/bin/sh\nexit 2\n");
    const result = await new FormatService().format("def (", join(wt, "a.py"), wt, AUTO_DETECT);
    expect(result).toEqual({ content: null });
  });
});
