import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { DEFAULT_FORMATTING_SETTINGS } from "@/lib/formatting-model";

import { FormatService } from "./format-service";
import { goFormatter, goFormatterWith } from "./go-formatter";
import { GO_ENV } from "./go-lsp-manager";

const GOLANGCI = "golangci-lint";
const REAL_PATH = process.env.PATH;
/** Longer than any test may take, so a loaded machine cannot turn a lookup into a timeout. */
const LOOKUP_WITHOUT_DEADLINE_MS = 600_000;
/** Always on the spawn PATH; listed last so a real tool there cannot shadow the fakes. */
const LOCAL_BIN = join(homedir(), ".local", "bin");

/** Reports which binary ran, from where and how, using only shell builtins: `PATH` is a test's. */
function reportScript(name: string): string {
  return `#!/bin/sh\necho "${name} cwd=$PWD args=$* GOPROXY=$GOPROXY GOTOOLCHAIN=$GOTOOLCHAIN GOSUMDB=$GOSUMDB GONOPROXY=$GONOPROXY"\n`;
}

const V2_CONFIG = 'version: "2"\nformatters:\n  enable: [gofumpt]\n';

/** A v2 config with these `formatters.exclusions.paths`; JSON is valid YAML, so patterns stay literal. */
function excludingConfig(...paths: string[]): string {
  return JSON.stringify({ version: "2", formatters: { enable: ["gci"], exclusions: { paths } } });
}

let temp: string;
let tools: string;
let wt: string;

async function addFiles(files: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(wt, name)), { recursive: true });
    await writeFile(join(wt, name), content);
  }
}

/** Installs a fake tool in `dir`. Each is written once, executable from creation (see `makeFakeVenv`). */
async function install(dir: string, name: string, script = reportScript(name)): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), script, { mode: 0o755 });
}

function save(name: string): Promise<{ content: string | null; notice?: string }> {
  return new FormatService().format(
    "package main\n",
    join(wt, name),
    wt,
    DEFAULT_FORMATTING_SETTINGS,
  );
}

beforeEach(async () => {
  temp = await realpath(await mkdtemp(join(tmpdir(), "go-formatter-")));
  tools = join(temp, "tools");
  wt = join(temp, "wt");
  await mkdir(tools);
  await mkdir(wt);
  process.env.PATH = `${tools}:${LOCAL_BIN}`;
});

afterEach(async () => {
  await rm(temp, { recursive: true, force: true });
});

afterAll(() => {
  process.env.PATH = REAL_PATH;
});

describe("goFormatter selection", () => {
  test("gofmt formats a file in a module, in the file's directory and offline", async () => {
    await install(tools, "gofmt");
    await addFiles({ "go.mod": "module m\n", "pkg/sub/a.go": "" });
    const { content, notice } = await save("pkg/sub/a.go");
    expect(notice).toBeUndefined();
    expect(content).toStartWith(`gofmt cwd=${join(wt, "pkg/sub")} args= `);
    for (const [name, value] of Object.entries(GO_ENV))
      expect(content).toContain(`${name}=${value}`);
  });

  test("a go.work counts as a module, and a loose file gets no formatter", async () => {
    await install(tools, "gofmt");
    await addFiles({ "work/go.work": "go 1.24\n", "work/a.go": "", "loose/a.go": "" });
    expect((await save("work/a.go")).content).toStartWith("gofmt ");
    expect((await save("loose/a.go")).content).toBeNull();
  });

  test.each([
    ["version 2 YAML", ".golangci.yml", V2_CONFIG],
    ["version 2 as a number", ".golangci.yaml", "version: 2\nformatters:\n  enable: [gofumpt]\n"],
    ["JSON", ".golangci.json", JSON.stringify({ version: "2", formatters: { enable: ["gci"] } })],
    ["TOML", ".golangci.toml", 'version = "2"\n[formatters]\nenable = ["gofumpt"]\n'],
  ])("%s selects golangci-lint, without needing a go.mod", async (_, name, config) => {
    await install(tools, GOLANGCI);
    await addFiles({ [name]: config, "pkg/a.go": "" });
    const { content } = await save("pkg/a.go");
    expect(content).toStartWith(
      `golangci-lint cwd=${join(wt, "pkg")} args=fmt --stdin --config ../${name} `,
    );
  });

  test.each([
    ["no version", "formatters:\n  enable: [gofumpt]\n"],
    ["a v1 config", 'version: "1"\nformatters:\n  enable: [gofumpt]\n'],
    ["no formatters", 'version: "2"\nlinters:\n  enable: [errcheck]\n'],
    ["empty enable", 'version: "2"\nformatters:\n  enable: []\n'],
    ["unparsable", "bad: [\n"],
  ])("%s falls to gofmt", async (_, config) => {
    await install(tools, "gofmt");
    await install(tools, GOLANGCI);
    await addFiles({ "go.mod": "module m\n", ".golangci.yml": config, "a.go": "" });
    expect((await save("a.go")).content).toStartWith("gofmt ");
  });

  test("the nearest config decides alone, in golangci-lint's name order", async () => {
    await install(tools, "gofmt");
    await install(tools, GOLANGCI);
    await addFiles({
      "go.mod": "module m\n",
      ".golangci.yml": V2_CONFIG,
      "own/.golangci.yml": V2_CONFIG,
      "own/.golangci.json": JSON.stringify({ version: "2", formatters: { enable: ["gci"] } }),
      "own/a.go": "",
      "optedout/.golangci.yml": 'version: "2"\n',
      "optedout/a.go": "",
      "inherits/a.go": "",
    });
    expect((await save("own/a.go")).content).toContain("--config .golangci.json ");
    expect((await save("optedout/a.go")).content).toStartWith("gofmt ");
    expect((await save("inherits/a.go")).content).toContain("--config ../.golangci.yml ");
  });

  test.skipIf(Boolean(Bun.which(GOLANGCI, { PATH: LOCAL_BIN })))(
    "a config found without golangci-lint installed falls to gofmt, without a notice",
    async () => {
      await install(tools, "gofmt");
      await addFiles({ "go.mod": "module m\n", ".golangci.yml": V2_CONFIG, "a.go": "" });
      const { content, notice } = await save("a.go");
      expect(content).toStartWith("gofmt ");
      expect(notice).toBeUndefined();
    },
  );

  test("vendor and testdata get no formatter, but a similar name does", async () => {
    await install(tools, "gofmt");
    await addFiles({
      "go.mod": "module m\n",
      "vendor/x/a.go": "",
      "pkg/testdata/a.go": "",
      "vendored/a.go": "",
    });
    expect((await save("vendor/x/a.go")).content).toBeNull();
    expect((await save("pkg/testdata/a.go")).content).toBeNull();
    expect((await save("vendored/a.go")).content).toStartWith("gofmt ");
  });

  test("a worktree inside a directory called vendor still formats", async () => {
    await install(tools, "gofmt");
    wt = join(temp, "vendor", "wt");
    await addFiles({ "go.mod": "module m\n", "a.go": "" });
    expect((await save("a.go")).content).toStartWith("gofmt ");
  });

  test("Settings lists a formatter for a Go root only", async () => {
    await install(tools, "gofmt");
    await addFiles({ "sub/go.mod": "module m\n", "package.json": "{}" });
    const service = new FormatService();
    expect(service.getDetectedFormatters(wt)).toEqual([]);
    await addFiles({ "go.mod": "module m\n" });
    expect(service.getDetectedFormatters(wt)).toEqual([{ command: "gofmt", extensions: ["go"] }]);
  });
});

describe("goFormatter exclusions", () => {
  async function setUp(...paths: string[]): Promise<void> {
    await install(tools, "gofmt");
    await install(tools, GOLANGCI);
    await addFiles({ "go.mod": "module m\n", ".golangci.yml": excludingConfig(...paths) });
  }

  test("a pattern can match the file name or the directory", async () => {
    await setUp("_gen\\.go$", "^third_party/");
    expect((await save("pkg/a_gen.go")).content).toBeNull();
    expect((await save("third_party/x/a.go")).content).toBeNull();
    expect((await save("pkg/a.go")).content).toStartWith("golangci-lint ");
  });

  test("patterns are relative to the config's directory by default", async () => {
    await install(tools, GOLANGCI);
    await addFiles({ "mod/.golangci.yml": excludingConfig("^gen/"), "gen/a.go": "" });
    expect((await save("mod/gen/a.go")).content).toBeNull();
    expect((await save("mod/other/gen/a.go")).content).toStartWith("golangci-lint ");
  });

  test("run.relative-path-mode gomod matches from the module", async () => {
    await install(tools, GOLANGCI);
    const config = {
      version: "2",
      run: { "relative-path-mode": "gomod" },
      formatters: { enable: ["gci"], exclusions: { paths: ["^gen/"] } },
    };
    await addFiles({ ".golangci.yml": JSON.stringify(config), "mod/go.mod": "module m\n" });
    expect((await save("mod/gen/a.go")).content).toBeNull();
    expect((await save("gen/x/a.go")).content).toBeNull();
    expect((await save("mod/x/gen/a.go")).content).toStartWith("golangci-lint ");
  });

  test("Go syntax JavaScript lacks is translated", async () => {
    await setUp("(?i)_GEN\\.go\\z", "(?P<dir>^tools)/");
    expect((await save("a_gen.go")).content).toBeNull();
    expect((await save("tools/a.go")).content).toBeNull();
  });

  test("a pattern within the budget for this path runs", async () => {
    await setUp(".*/.*/.*_gen\\.go$");
    expect((await save("a/b/c_gen.go")).content).toBeNull();
    expect((await save("a/b/c.go")).content).toStartWith("golangci-lint ");
  });

  test.each([
    ["a repeated group", "(a+)+$"],
    ["a POSIX class", "^[[:alpha:]]+\\.go$"],
    ["a Unicode class", "\\pL+\\.go$"],
    ["a quoted literal", "\\Qa.b\\E"],
    ["a class starting with ]", "^[^]]+\\.go$"],
    ["a flag JavaScript lacks", "(?U)a"],
    ["no Go meaning", "a(?=b)"],
  ])("%s cannot run, so the file is left alone", async (_, pattern) => {
    await setUp(pattern);
    expect((await save("zzz.go")).content).toBeNull();
  });

  test("a pattern over the budget for a long path leaves that file alone", async () => {
    await setUp(".*.*.*x");
    expect((await save(`${"a".repeat(200)}.go`)).content).toBeNull();
    expect((await save("a.go")).content).toStartWith("golangci-lint ");
  });

  test("patterns share one budget", async () => {
    await setUp(...Array.from({ length: 30 }, (_, i) => `.*.*x${i}`));
    expect((await save(`${"a".repeat(100)}.go`)).content).toBeNull();
  });

  test("a non-string pattern cannot run", async () => {
    await install(tools, GOLANGCI);
    const config = { version: "2", formatters: { enable: ["gci"], exclusions: { paths: [1] } } };
    await addFiles({ ".golangci.yml": JSON.stringify(config) });
    expect((await save("a.go")).content).toBeNull();
  });
});

describe("goFormatter binaries", () => {
  test("a tool on PATH inside the worktree is not used", async () => {
    await install(tools, "gofmt", reportScript("outside"));
    await install(join(wt, "bin"), "gofmt", reportScript("inside"));
    await install(join(wt, "bin"), GOLANGCI, reportScript("inside"));
    await addFiles({ "go.mod": "module m\n", ".golangci.yml": V2_CONFIG, "a.go": "" });
    process.env.PATH = `${join(wt, "bin")}:bin:${tools}:${LOCAL_BIN}`;
    expect((await save("a.go")).content).toStartWith("outside ");
  });

  test("a manual override gets the same cwd and environment", async () => {
    await install(tools, "gofumpt");
    await addFiles({ "go.mod": "module m\n", "pkg/a.go": "" });
    const { content } = await new FormatService().format(
      "package main\n",
      join(wt, "pkg/a.go"),
      wt,
      {
        ...DEFAULT_FORMATTING_SETTINGS,
        overrides: [{ id: "go", extensions: "go", command: "gofumpt", args: "" }],
      },
    );
    expect(content).toStartWith(`gofumpt cwd=${join(wt, "pkg")} `);
    expect(content).toContain("GOTOOLCHAIN=local");
  });

  test("a saved file whose directory is gone runs from the nearest existing one", async () => {
    await install(tools, GOLANGCI);
    await addFiles({ ".golangci.yml": V2_CONFIG });
    const { content } = await save("gone/deep/a.go");
    expect(content).toStartWith(`golangci-lint cwd=${wt} args=fmt --stdin --config .golangci.yml `);
  });

  test("--config reaches the config when the file's directory is a symlink", async () => {
    await install(tools, GOLANGCI, '#!/bin/sh\n[ -f "$4" ] && echo "found $4"\n');
    await addFiles({ ".golangci.yml": V2_CONFIG, "real/deep/a.go": "" });
    await symlink(join(wt, "real/deep"), join(wt, "pkg"));
    expect((await save("pkg/a.go")).content).toBe("found ../../.golangci.yml\n");
  });

  test("a config only reachable through whitespace falls to gofmt", async () => {
    await install(tools, "gofmt");
    await install(tools, GOLANGCI);
    await addFiles({ "go.mod": "module m\n", "a b/.golangci.yml": V2_CONFIG, "c/deep/a.go": "" });
    await symlink(join(wt, "c/deep"), join(wt, "a b/pkg"));
    expect((await save("a b/pkg/a.go")).content).toStartWith("gofmt ");
  });

  test("a config that is a symlink loop counts as no config", async () => {
    await install(tools, "gofmt");
    await addFiles({ "go.mod": "module m\n" });
    await symlink(join(wt, ".golangci.yml"), join(wt, ".golangci.yml"));
    expect((await save("a.go")).content).toStartWith("gofmt ");
  });

  test("gofmt missing from PATH is taken from GOROOT, looked up offline", async () => {
    const goroot = join(temp, "goroot");
    await install(join(goroot, "bin"), "gofmt", reportScript("goroot-gofmt"));
    await install(
      tools,
      "go",
      `#!/bin/sh\n[ "$GOTOOLCHAIN" = local ] && [ "$1 $2" = "env GOROOT" ] && echo "${goroot}"\n`,
    );
    await addFiles({ "go.mod": "module m\n", "a.go": "" });
    const service = new FormatService([goFormatterWith(LOOKUP_WITHOUT_DEADLINE_MS)]);
    const { content } = await service.format(
      "package main\n",
      join(wt, "a.go"),
      wt,
      DEFAULT_FORMATTING_SETTINGS,
    );
    expect(content).toStartWith("goroot-gofmt ");
  });

  test.each([
    ["inside the worktree", (root: string) => join(root, "goroot")],
    ["relative", () => "goroot"],
  ])("a GOROOT %s is not used", async (_, goroot) => {
    const ran = join(temp, "ran");
    await install(tools, "go", `#!/bin/sh\n: > "${ran}"\necho "${goroot(wt)}"\n`);
    const formatter = goFormatterWith(LOOKUP_WITHOUT_DEADLINE_MS);
    const options = await formatter.spawnOptions?.("gofmt", wt, wt);
    expect(options?.binDirs).toEqual([]);
    expect(existsSync(ran)).toBe(true);
  });

  test.skipIf(Boolean(Bun.which("go", { PATH: LOCAL_BIN })))(
    "gofmt with neither it nor go on PATH adds nothing",
    async () => {
      const options = await goFormatter.spawnOptions?.("gofmt", wt, wt);
      expect(options).toEqual({
        cwd: wt,
        env: { ...GO_ENV, PATH: `${tools}:${LOCAL_BIN}` },
        binDirs: [],
      });
    },
  );

  test("a go failing to report GOROOT adds nothing", async () => {
    const ran = join(temp, "ran");
    await install(tools, "go", `#!/bin/sh\n: > "${ran}"\necho /opt/go\nexit 1\n`);
    const formatter = goFormatterWith(LOOKUP_WITHOUT_DEADLINE_MS);
    const options = await formatter.spawnOptions?.("gofmt", wt, wt);
    expect(options?.binDirs).toEqual([]);
    expect(existsSync(ran)).toBe(true);
  });

  test("a go that never answers does not hold up the save", async () => {
    await install(tools, "go", "#!/bin/sh\ntrap '' TERM\nexec /bin/sleep 600\n");
    const options = await goFormatterWith(10).spawnOptions?.("gofmt", wt, wt);
    expect(options?.binDirs).toEqual([]);
  });
});
