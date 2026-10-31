import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { DEFAULT_FORMATTING_SETTINGS } from "@/lib/formatting-model";

import { FormatService } from "./format-service";

const REAL_ENV = { ...process.env };
const ARCH_ROOT = `DOTNET_ROOT_${process.arch.toUpperCase()}`;
/** The SDK check runs git, whose directory on a real `PATH` can also hold a real dotnet. */
const REAL_GIT = Bun.which("git");
const CSHARPIER_TOOL = { version: "1.3.0", commands: ["csharpier"] };

let temp: string;
let tools: string;
let wt: string;
let ranMarker: string;
let gitBin: string;

/** Reports how it ran, using only shell builtins: `PATH` is a test's. */
function reportScript(name: string): string {
  return `#!/bin/sh\n: > "${ranMarker}"\necho "${name} cwd=$PWD args=$* telemetry=$DOTNET_CLI_TELEMETRY_OPTOUT nologo=$DOTNET_NOLOGO path=$PATH"\n`;
}

async function addFiles(files: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(wt, name)), { recursive: true });
    await writeFile(join(wt, name), content);
  }
}

function manifest(tools: Record<string, unknown>, isRoot = false): string {
  return JSON.stringify({ version: 1, isRoot, tools });
}

/** Each tool is written once, executable from creation (see `makeFakeVenv`). */
async function install(dir: string, name: string, script = reportScript(name)): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), script, { mode: 0o755 });
}

function save(name: string): Promise<{ content: string | null; notice?: string }> {
  return new FormatService().format(
    "class A { }\n",
    join(wt, name),
    wt,
    DEFAULT_FORMATTING_SETTINGS,
  );
}

beforeEach(async () => {
  temp = await realpath(await mkdtemp(join(tmpdir(), "csharp-formatter-")));
  tools = join(temp, "tools");
  wt = join(temp, "wt");
  ranMarker = join(temp, "ran");
  await mkdir(tools);
  await mkdir(wt);
  gitBin = join(temp, "git-bin");
  await mkdir(gitBin);
  await symlink(REAL_GIT!, join(gitBin, "git"));
  // The spawn PATH always has the home's `.local/bin`: a temporary home keeps real tools out of it.
  process.env.HOME = temp;
  process.env.PATH = `${tools}:${gitBin}`;
  delete process.env.DOTNET_ROOT;
  delete process.env[ARCH_ROOT];
});

afterEach(async () => {
  await rm(temp, { recursive: true, force: true });
});

afterAll(() => {
  process.env.HOME = REAL_ENV.HOME;
  process.env.PATH = REAL_ENV.PATH;
  if (REAL_ENV.DOTNET_ROOT) process.env.DOTNET_ROOT = REAL_ENV.DOTNET_ROOT;
  if (REAL_ENV[ARCH_ROOT]) process.env[ARCH_ROOT] = REAL_ENV[ARCH_ROOT];
});

describe("csharpFormatter selection", () => {
  test.each([".csproj", ".editorconfig", "Directory.Build.props", "dotnet-tools.json"])(
    "%s alone formats nothing",
    async (signal) => {
      await install(tools, "dotnet");
      await install(tools, "csharpier");
      await addFiles({ [signal]: signal === "dotnet-tools.json" ? manifest({}) : "", "a.cs": "" });
      expect(await save("a.cs")).toEqual({ content: null });
      expect(existsSync(ranMarker)).toBe(false);
    },
  );

  test.each([".csharpierrc", ".csharpierrc.json", ".csharpierrc.yaml", ".csharpierrc.yml"])(
    "%s selects csharpier from PATH, for a file in a subproject",
    async (config) => {
      await install(tools, "csharpier");
      await addFiles({ [`apps/api/${config}`]: "printWidth: 80\n" });
      const { content } = await save("apps/api/src/a.cs");
      const file = join(wt, "apps/api/src/a.cs");
      expect(content).toContain(`csharpier cwd=${homedir()} args=format --stdin-path ${file}`);
    },
  );

  test("a config above another project does not reach a sibling", async () => {
    await install(tools, "csharpier");
    await addFiles({ "apps/api/.csharpierrc": "" });
    expect(await save("apps/web/a.cs")).toEqual({ content: null });
  });

  test("a directory named like a config does not count", async () => {
    await install(tools, "csharpier");
    await mkdir(join(wt, ".csharpierrc"));
    expect(await save("a.cs")).toEqual({ content: null });
  });

  test.each(["a.csx", "a.cs"])("%s is formatted", async (name) => {
    await install(tools, "csharpier");
    await addFiles({ ".csharpierrc": "" });
    expect((await save(name)).content).toContain("csharpier");
  });

  test.each(["a.csproj", "Directory.Build.props", "a.xaml"])("%s is left alone", async (name) => {
    await install(tools, "csharpier");
    await addFiles({ ".csharpierrc": "" });
    expect(await save(name)).toEqual({ content: null });
  });
});

describe("csharpFormatter local tool", () => {
  test.each([".config/dotnet-tools.json", "dotnet-tools.json"])(
    "%s runs the tool from the manifest's directory, with dotnet's environment",
    async (path) => {
      await install(tools, "dotnet");
      await addFiles({ [`svc/${path}`]: manifest({ csharpier: CSHARPIER_TOOL }) });
      const { content } = await save("svc/src/deep/a.cs");
      const file = join(wt, "svc/src/deep/a.cs");
      expect(content).toContain(
        `dotnet cwd=${join(wt, "svc")} args=tool run csharpier format --stdin-path ${file} telemetry=1 nologo=1`,
      );
    },
  );

  test("a relative PATH entry is dropped, as dotnet runs inside the project", async () => {
    await install(tools, "dotnet");
    process.env.PATH = `${tools}:relative/bin:${gitBin}`;
    await addFiles({ "dotnet-tools.json": manifest({ csharpier: CSHARPIER_TOOL }) });
    const { content } = await save("a.cs");
    expect(content).toContain("path=");
    expect(content).not.toContain("relative/bin");
  });

  test("wins over csharpier on PATH", async () => {
    await install(tools, "dotnet");
    await install(tools, "csharpier");
    await addFiles({
      ".csharpierrc": "",
      "dotnet-tools.json": manifest({ CSharpier: CSHARPIER_TOOL }),
    });
    expect((await save("a.cs")).content).toContain("dotnet cwd=");
  });

  test("a manifest with comments and trailing commas is read, as dotnet reads it", async () => {
    await install(tools, "dotnet");
    await addFiles({
      "dotnet-tools.json": `{ // tools\n"tools": { "csharpier": { "commands": ["csharpier"], }, }, }`,
    });
    expect((await save("a.cs")).content).toContain("dotnet cwd=");
  });

  test("a nearer manifest without it passes the search up", async () => {
    await install(tools, "dotnet");
    await addFiles({
      "dotnet-tools.json": manifest({ csharpier: CSHARPIER_TOOL }),
      "svc/dotnet-tools.json": manifest({ other: { commands: ["other"] } }),
    });
    expect((await save("svc/a.cs")).content).toContain(`dotnet cwd=${wt} `);
  });

  test("a nearer root manifest without it stops the search, as it stops dotnet's", async () => {
    await install(tools, "dotnet");
    await addFiles({
      "dotnet-tools.json": manifest({ csharpier: CSHARPIER_TOOL }),
      "svc/dotnet-tools.json": manifest({}, true),
    });
    expect(await save("svc/a.cs")).toEqual({ content: null });
  });

  test.each([
    ["the old command name", { csharpier: { commands: ["dotnet-csharpier"] } }],
    ["another package claiming the command", { other: CSHARPIER_TOOL }],
    ["two packages claiming the command", { csharpier: CSHARPIER_TOOL, other: CSHARPIER_TOOL }],
  ])("%s does not count", async (_name, listed) => {
    await install(tools, "dotnet");
    await addFiles({ "dotnet-tools.json": manifest(listed) });
    expect(await save("a.cs")).toEqual({ content: null });
    expect(existsSync(ranMarker)).toBe(false);
  });

  test("a manifest over the size limit is not read", async () => {
    await install(tools, "dotnet");
    const padding = " ".repeat(1_024 * 1_024);
    await addFiles({ "dotnet-tools.json": manifest({ csharpier: CSHARPIER_TOOL }) + padding });
    expect(await save("a.cs")).toEqual({ content: null });
  });

  test("a tool that is not restored says what to run", async () => {
    await install(
      tools,
      "dotnet",
      `#!/bin/sh\necho 'Run "dotnet tool restore" to make the "csharpier" command available.' >&2\nexit 1\n`,
    );
    await addFiles({ "dotnet-tools.json": manifest({ csharpier: CSHARPIER_TOOL }) });
    const { content, notice } = await save("a.cs");
    expect(content).toBeNull();
    expect(notice).toContain("`dotnet tool restore`");
  });

  test("no dotnet says so, and nothing runs", async () => {
    await addFiles({ "dotnet-tools.json": manifest({ csharpier: CSHARPIER_TOOL }) });
    const { content, notice } = await save("a.cs");
    expect(content).toBeNull();
    expect(notice).toContain("Install the .NET SDK");
  });

  test("when the SDK check refuses, dotnet does not run and no notice shows", async () => {
    await install(tools, "dotnet");
    await addFiles({
      "dotnet-tools.json": manifest({ csharpier: CSHARPIER_TOOL }),
      "global.json": "{",
    });
    expect(await save("a.cs")).toEqual({ content: null });
    expect(existsSync(ranMarker)).toBe(false);
  });

  test("another project's global.json does not hold this one back", async () => {
    await install(tools, "dotnet");
    await addFiles({
      "svc/dotnet-tools.json": manifest({ csharpier: CSHARPIER_TOOL }),
      "other/global.json": "{",
    });
    expect((await save("svc/a.cs")).content).toContain("dotnet cwd=");
  });

  test("a manual dotnet override goes through the same check", async () => {
    await install(tools, "dotnet");
    await addFiles({ "global.json": "{" });
    const settings = {
      ...DEFAULT_FORMATTING_SETTINGS,
      overrides: [{ id: "o1", extensions: "cs", command: "dotnet", args: "format" }],
    };
    const result = await new FormatService().format("", join(wt, "a.cs"), wt, settings);
    expect(result).toEqual({ content: null });
    expect(existsSync(ranMarker)).toBe(false);
  });

  test("a version manager's shim does not run in the project", async () => {
    await install(join(temp, "shims"), "dotnet");
    process.env.PATH = `${join(temp, "shims")}:${gitBin}`;
    await addFiles({ "dotnet-tools.json": manifest({ csharpier: CSHARPIER_TOOL }) });
    const { content, notice } = await save("a.cs");
    expect(content).toBeNull();
    expect(notice).toContain("shim");
    expect(existsSync(ranMarker)).toBe(false);
  });

  test("a dotnet in the worktree does not count", async () => {
    await install(join(wt, "bin"), "dotnet");
    process.env.PATH = `${join(wt, "bin")}:${gitBin}`;
    await addFiles({ "dotnet-tools.json": manifest({ csharpier: CSHARPIER_TOOL }) });
    const { content, notice } = await save("a.cs");
    expect(content).toBeNull();
    expect(notice).toContain("Install the .NET SDK");
    expect(existsSync(ranMarker)).toBe(false);
  });
});

describe("csharpFormatter failures", () => {
  test("a syntax error writes unformatted with no notice", async () => {
    await install(tools, "csharpier", `#!/bin/sh\necho "Error a.cs - syntax errors" >&2\nexit 1\n`);
    await addFiles({ ".csharpierrc": "" });
    expect(await save("a.cs")).toEqual({ content: null });
  });

  test("an ignored file, which prints nothing and exits 0, stays as it is", async () => {
    await install(tools, "csharpier", "#!/bin/sh\ncat > /dev/null\nexit 0\n");
    await addFiles({ ".csharpierrc": "" });
    expect(await save("a.cs")).toEqual({ content: null });
  });

  test("csharpier missing says how to get it", async () => {
    await addFiles({ ".csharpierrc": "" });
    const { content, notice } = await save("a.cs");
    expect(content).toBeNull();
    expect(notice).toContain("`dotnet tool install -g csharpier`");
  });

  test("a csharpier in the worktree, or a link to one, does not run", async () => {
    await install(join(wt, "bin"), "csharpier");
    await symlink(join(wt, "bin", "csharpier"), join(tools, "csharpier"));
    process.env.PATH = `${join(wt, "bin")}:${tools}:${gitBin}`;
    await addFiles({ ".csharpierrc": "" });
    const { content, notice } = await save("a.cs");
    expect(content).toBeNull();
    expect(notice).toContain("not on your PATH");
    expect(existsSync(ranMarker)).toBe(false);
  });
});
