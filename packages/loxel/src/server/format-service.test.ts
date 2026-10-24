import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { DEFAULT_FORMATTING_SETTINGS, type FormattingSettings } from "@/lib/formatting-model";

import { FormatService } from "./format-service";
import { findVenvBin } from "./python-formatter";

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

/** Install `ECHO_ARGS_SCRIPT` as `<venvDir>/bin/<command>` in a venv marked by `pyvenv.cfg`. */
async function makeFakeVenv(venvDir: string, command: string): Promise<void> {
  const bin = join(venvDir, "bin", command);
  await mkdir(dirname(bin), { recursive: true });
  await writeFile(join(venvDir, "pyvenv.cfg"), "home = /usr/bin\n");
  await writeFile(bin, ECHO_ARGS_SCRIPT);
  await chmod(bin, 0o755);
}

const AUTO_DETECT: FormattingSettings = DEFAULT_FORMATTING_SETTINGS;

function findFormatter(service: FormatService, wt: string, command: string) {
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
    await makeFakeVenv(join(wt, ".venv"), "ruff");
    await makeFakeVenv(join(wt, "services/api/.venv"), "ruff");
    // A directory named like a venv without `pyvenv.cfg` is not a venv.
    await mkdir(join(wt, "services/api/pkg/.venv/bin"), { recursive: true });
    const service = new FormatService();
    expect(service.getDetectedFormatters(wt)).toEqual([]);

    const api = join(wt, "services/api/pkg/mod.py");
    const result = await service.format("x=1\n", api, wt, AUTO_DETECT);
    expect(result.content).toBe(`ruff format --force-exclude --stdin-filename ${api}\n`);
    // The subproject's own venv wins over the root one: swap in a marker to tell them apart.
    await writeFile(join(wt, "services/api/.venv/bin/ruff"), "#!/bin/sh\necho subproject-venv\n");
    expect((await service.format("x=1\n", api, wt, AUTO_DETECT)).content).toBe("subproject-venv\n");

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
    expect(findVenvBin(join(wt, "repo/pkg"), join(wt, "repo"))).toBeUndefined();
    await makeFakeVenv(join(wt, "repo/venv"), "ruff");
    expect(findVenvBin(join(wt, "repo/pkg"), join(wt, "repo"))).toBe(join(wt, "repo/venv/bin"));
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
    await makeFakeVenv(join(wt, ".venv"), "ruff");
    await writeFile(join(wt, ".venv/bin/ruff"), "#!/nonexistent/python3\n");
    const result = await new FormatService().format("x=1\n", join(wt, "a.py"), wt, AUTO_DETECT);
    expect(result).toEqual({
      content: null,
      notice:
        'Format on save skipped: "ruff" could not be started; its interpreter may be missing.',
    });
  });

  test("does not report a formatter that exits non-zero (e.g. a syntax error)", async () => {
    const wt = await makeWorktree({ "ruff.toml": "" });
    await makeFakeVenv(join(wt, ".venv"), "ruff");
    await writeFile(join(wt, ".venv/bin/ruff"), "#!/bin/sh\nexit 2\n");
    const result = await new FormatService().format("def (", join(wt, "a.py"), wt, AUTO_DETECT);
    expect(result).toEqual({ content: null });
  });
});
