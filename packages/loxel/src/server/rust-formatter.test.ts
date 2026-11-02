import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { RustToolchain, RustTools } from "@/api/rust-toolchain-model";
import { DEFAULT_FORMATTING_SETTINGS, type FormattingSettings } from "@/lib/formatting-model";
import "@/test/temp-state-dir";

// The fakes here are scripts, which the lookup refuses; `rust-tool-shim.test.ts` covers that.
mock.module("./rust-tool-shim", () => ({ isVersionManagerShim: async () => false }));
const { FormatService } = await import("./format-service");
const { languageFormatters } = await import("./language-formatters");
const { rustFormatter, rustFormatterWith } = await import("./rust-formatter");

const REAL_ENV = { ...process.env };
const NO_DEADLINE_MS = 600_000;
const STABLE = "stable-aarch64-apple-darwin";
const GIT = Bun.which("git");

/** Reports how it ran, using only shell builtins: `PATH` is a test's. */
const REPORT = `#!/bin/sh
echo "$0 cwd=$PWD args=$* install=$RUSTUP_AUTO_INSTALL toolchain=$RUSTUP_TOOLCHAIN"
`;

let temp: string;
let wt: string;
let bin: string;

async function addFiles(files: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(wt, name)), { recursive: true });
    await writeFile(join(wt, name), content);
  }
}

async function install(path: string, script = REPORT): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, script, { mode: 0o755 });
  return path;
}

function active(tools: Partial<RustTools>, name: string | null = STABLE): RustToolchain {
  return {
    status: "active",
    source: "default",
    name,
    version: "1.99.0",
    rustcPath: join(temp, "toolchain/bin/rustc"),
    sysroot: join(temp, "toolchain"),
    toolchainFile: null,
    tools: {
      cargo: null,
      rustfmt: null,
      cargoClippy: null,
      rustAnalyzer: null,
      rustSrc: false,
      ...tools,
    },
  };
}

function save(
  file: string,
  toolchain: RustToolchain,
  settings: FormattingSettings = DEFAULT_FORMATTING_SETTINGS,
) {
  const language = rustFormatterWith(NO_DEADLINE_MS, async () => toolchain);
  return new FormatService([language]).format("fn main() {}\n", join(wt, file), wt, settings);
}

/** Saves with a toolchain whose rustfmt reports its arguments, which it returns. */
async function argsFor(file: string): Promise<string | undefined> {
  const rustfmt = await install(join(temp, "toolchain/bin/rustfmt"));
  const { content } = await save(file, active({ rustfmt }));
  return content === null ? undefined : /args=(.*) install=/.exec(content)?.[1];
}

beforeEach(async () => {
  temp = await realpath(await mkdtemp(join(tmpdir(), "rust-formatter-")));
  wt = join(temp, "wt");
  bin = join(temp, "bin");
  await mkdir(wt);
  await mkdir(bin);
});

afterEach(async () => {
  process.env.PATH = REAL_ENV.PATH;
  await rm(temp, { recursive: true, force: true });
});

afterAll(() => {
  Object.assign(process.env, REAL_ENV);
});

describe("which files get rustfmt", () => {
  test("a crate, from any depth and in the worktree's directory", async () => {
    await addFiles({ "Cargo.toml": '[package]\nedition = "2021"\n', "src/deep/a.rs": "" });
    const rustfmt = await install(join(temp, "toolchain/bin/rustfmt"));
    const { content } = await save("src/deep/a.rs", active({ rustfmt }));
    expect(content).toStartWith(`${rustfmt} cwd=${wt} args=--edition 2021 `);
  });

  test.each(["rustfmt.toml", ".rustfmt.toml"])("%s alone, with no edition flag", async (name) => {
    await addFiles({ [name]: "", "tool/a.rs": "" });
    expect(await argsFor("tool/a.rs")).toBe(`--config-path ${name}`);
  });

  test("a loose file gets nothing", async () => {
    await addFiles({ "a.rs": "" });
    expect(await argsFor("a.rs")).toBeUndefined();
  });

  test("a directory by those names doesn't count as a project file", async () => {
    await mkdir(join(wt, "Cargo.toml"));
    await mkdir(join(wt, "rustfmt.toml"));
    await addFiles({ "a.rs": "" });
    expect(await argsFor("a.rs")).toBeUndefined();
  });

  test("a manifest over the size limit doesn't count", async () => {
    await addFiles({ "Cargo.toml": `#${"x".repeat(1024 * 1024)}\n`, "a.rs": "" });
    expect(await argsFor("a.rs")).toBeUndefined();
  });

  test("auto-detect off formats nothing", async () => {
    await addFiles({ "Cargo.toml": "[package]\n", "a.rs": "" });
    const rustfmt = await install(join(temp, "toolchain/bin/rustfmt"));
    const settings = { ...DEFAULT_FORMATTING_SETTINGS, autoDetect: false };
    expect(await save("a.rs", active({ rustfmt }), settings)).toEqual({ content: null });
  });
});

describe("the edition", () => {
  test.each([
    ["names one", '[package]\nedition = "2024"\n', "--edition 2024"],
    ["names none, as Cargo reads it", "[package]\n", "--edition 2015"],
    ["is a virtual workspace", "[workspace]\n", ""],
  ])("a manifest that %s", async (_name, manifest, args) => {
    await addFiles({ "Cargo.toml": manifest, "a.rs": "" });
    expect(await argsFor("a.rs")).toBe(args);
  });

  test("comes from the workspace root when inherited", async () => {
    await addFiles({
      "Cargo.toml": '[workspace]\nmembers = ["crates/*"]\n[workspace.package]\nedition = "2024"\n',
      "crates/a/Cargo.toml": "[package]\nedition.workspace = true\n",
      "crates/a/src/lib.rs": "",
    });
    expect(await argsFor("crates/a/src/lib.rs")).toBe("--edition 2024");
  });

  test("package.workspace names the root over a nearer workspace", async () => {
    await addFiles({
      "root/Cargo.toml": '[workspace]\n[workspace.package]\nedition = "2018"\n',
      "Cargo.toml": '[workspace]\n[workspace.package]\nedition = "2024"\n',
      "m/Cargo.toml": '[package]\nworkspace = "../root"\nedition.workspace = true\n',
      "m/a.rs": "",
    });
    expect(await argsFor("m/a.rs")).toBe("--edition 2018");
  });

  test("the nearest manifest decides for a member with its own", async () => {
    await addFiles({
      "Cargo.toml": '[workspace]\n[workspace.package]\nedition = "2024"\n',
      "crates/a/Cargo.toml": '[package]\nedition = "2018"\n',
      "crates/a/lib.rs": "",
    });
    expect(await argsFor("crates/a/lib.rs")).toBe("--edition 2018");
  });

  test("beats the config's edition, as in cargo fmt", async () => {
    await addFiles({
      "Cargo.toml": '[package]\nedition = "2021"\n',
      "rustfmt.toml": 'edition = "2024"\n',
      "a.rs": "",
    });
    expect(await argsFor("a.rs")).toBe("--edition 2021 --config-path rustfmt.toml");
  });

  test.each([
    ["broken", "[package\n"],
    ["an inherited edition with no workspace", "[package]\nedition.workspace = true\n"],
    ["a non-string edition", "[package]\nedition = 2021\n"],
    ["an edition carrying other arguments", '[package]\nedition = "2021 --check"\n'],
  ])("a manifest with %s saves unformatted", async (_name, manifest) => {
    await addFiles({ "Cargo.toml": manifest, "a.rs": "" });
    const rustfmt = await install(join(temp, "toolchain/bin/rustfmt"));
    expect(await save("a.rs", active({ rustfmt }))).toEqual({ content: null });
  });
});

describe("the config", () => {
  test("the nearest applies, with both names in one directory as rustfmt prefers", async () => {
    await addFiles({
      "Cargo.toml": "[workspace]\n",
      "rustfmt.toml": "",
      "crates/a/Cargo.toml": '[package]\nedition = "2021"\n',
      "crates/a/rustfmt.toml": "",
      "crates/a/.rustfmt.toml": "",
      "crates/a/src/lib.rs": "",
      "crates/b/Cargo.toml": '[package]\nedition = "2021"\n',
      "crates/b/lib.rs": "",
    });
    expect(await argsFor("crates/a/src/lib.rs")).toBe(
      "--edition 2021 --config-path crates/a/.rustfmt.toml",
    );
    expect(await argsFor("crates/b/lib.rs")).toBe("--edition 2021 --config-path rustfmt.toml");
  });

  test("a path with a space declines with a notice", async () => {
    await addFiles({ "my crate/rustfmt.toml": "", "my crate/a.rs": "" });
    const { content, notice } = await save("my crate/a.rs", active({}));
    expect(content).toBeNull();
    expect(notice).toContain("my crate/rustfmt.toml");
  });

  test("a worktree path with a space still works", async () => {
    wt = join(temp, "my wt");
    await addFiles({ "rustfmt.toml": "", "a.rs": "" });
    expect(await argsFor("a.rs")).toBe("--config-path rustfmt.toml");
  });
});

describe("which rustfmt runs", () => {
  beforeEach(() => addFiles({ "Cargo.toml": '[package]\nedition = "2021"\n', "a.rs": "" }));

  test("the toolchain's, ahead of a PATH one, kept from installing and on the resolved toolchain", async () => {
    await install(join(bin, "rustfmt"), '#!/bin/sh\necho "from PATH"\n');
    process.env.PATH = bin;
    const rustfmt = await install(join(temp, "toolchain/bin/rustfmt"));
    const { content } = await save("a.rs", active({ rustfmt }));
    expect(content).toStartWith(rustfmt);
    expect(content).toContain("install=0 ");
    expect(content).toContain(`toolchain=${STABLE}`);
  });

  test("without rustup there is no toolchain to pin", async () => {
    const rustfmt = await install(join(temp, "toolchain/bin/rustfmt"));
    const { content } = await save("a.rs", active({ rustfmt }, null));
    expect(content).toContain("toolchain=\n");
  });

  test.each<[string, RustToolchain, string]>([
    [
      "a pinned toolchain that is not installed",
      { status: "not-installed", source: "toolchain-file", name: "1.77.7", toolchainFile: null },
      "`rustup toolchain install`",
    ],
    ["no Rust", { status: "none", rustupPath: null, detail: null }, "https://rustup.rs"],
    [
      "rustup with no toolchain",
      { status: "none", rustupPath: "/bin/rustup", detail: null },
      "`rustup default stable`",
    ],
    [
      "what rustup reported",
      { status: "none", rustupPath: "/bin/rustup", detail: "Run `rustup self update`." },
      "Run `rustup self update`.",
    ],
    [
      "a toolchain Loxel won't use",
      { status: "refused", name: "x", toolchainFile: null, rustcPath: "/x/rustc" },
      "Rust: Select Toolchain",
    ],
  ])("%s runs nothing and says what to do", async (_name, toolchain, says) => {
    await install(join(bin, "rustfmt"), '#!/bin/sh\necho "must not run"\n');
    process.env.PATH = bin;
    const { content, notice } = await save("a.rs", toolchain);
    expect(content).toBeNull();
    expect(notice).toContain(says);
  });

  test("a toolchain without the component runs nothing and names the command", async () => {
    await install(join(bin, "rustfmt"), '#!/bin/sh\necho "must not run"\n');
    process.env.PATH = bin;
    const { content, notice } = await save("a.rs", active({ rustfmt: null }));
    expect(content).toBeNull();
    expect(notice).toContain(`\`rustup component add rustfmt --toolchain ${STABLE}\``);
  });

  test("an install without rustup and without rustfmt doesn't mention rustup", async () => {
    const plain: RustToolchain = { ...active({}, null), source: "no-rustup" } as RustToolchain;
    const { content, notice } = await save("a.rs", plain);
    expect(content).toBeNull();
    expect(notice).toContain("no rustfmt");
    expect(notice).not.toContain("rustup");
  });

  test("a project's node_modules/.bin rustfmt isn't used", async () => {
    await install(join(wt, "node_modules/.bin/rustfmt"), '#!/bin/sh\necho "must not run"\n');
    const rustfmt = await install(join(temp, "toolchain/bin/rustfmt"));
    expect((await save("a.rs", active({ rustfmt }))).content).toStartWith(rustfmt);
  });

  test("a tool gone since the resolution gets a notice and no other rustfmt", async () => {
    await install(join(bin, "rustfmt"), '#!/bin/sh\necho "must not run"\n');
    process.env.PATH = bin;
    const { content, notice } = await save(
      "a.rs",
      active({ rustfmt: join(temp, "gone/bin/rustfmt") }),
    );
    expect(content).toBeNull();
    expect(notice).toContain("rustfmt was not found");
  });

  test("a toolchain lookup that doesn't answer in time skips quietly", async () => {
    const language = rustFormatterWith(1, () => new Promise(() => {}));
    const result = await new FormatService([language]).format(
      "x",
      join(wt, "a.rs"),
      wt,
      DEFAULT_FORMATTING_SETTINGS,
    );
    expect(result).toEqual({ content: null });
  });

  test("a failing lookup skips quietly rather than running a PATH rustfmt", async () => {
    const language = rustFormatterWith(NO_DEADLINE_MS, () => Promise.reject(new Error("boom")));
    const result = await new FormatService([language]).format(
      "x",
      join(wt, "a.rs"),
      wt,
      DEFAULT_FORMATTING_SETTINGS,
    );
    expect(result).toEqual({ content: null });
  });
});

describe("failures", () => {
  beforeEach(() => addFiles({ "Cargo.toml": "[package]\n", "a.rs": "" }));

  /** A save whose rustfmt writes `stderr` and exits 1. */
  async function failing(stderr: string) {
    const rustfmt = await install(
      join(temp, "toolchain/bin/rustfmt"),
      `#!/bin/sh\necho "${stderr}" >&2\nexit 1\n`,
    );
    return save("a.rs", active({ rustfmt }));
  }

  test("a syntax error stays quiet", async () => {
    expect(await failing("error: expected one of x, found y")).toEqual({ content: null });
  });

  test("a syntax error quoting rustup's words stays quiet", async () => {
    expect(await failing("  | x 'rustfmt' is not installed for the toolchain")).toEqual({
      content: null,
    });
  });

  test("a component removed since the lookup says what to run", async () => {
    const { notice } = await failing(
      "error: 'rustfmt' is not installed for the toolchain '1.90.0-aarch64-apple-darwin'.",
    );
    expect(notice).toContain(
      "`rustup component add rustfmt --toolchain 1.90.0-aarch64-apple-darwin`",
    );
  });

  test("a toolchain removed since the lookup says what to run", async () => {
    const { notice } = await failing(
      "error: toolchain '1.77.7-aarch64-apple-darwin' is not installed",
    );
    expect(notice).toContain("`rustup toolchain install`");
  });
});

describe("manual overrides", () => {
  const overriding = (command: string): FormattingSettings => ({
    ...DEFAULT_FORMATTING_SETTINGS,
    overrides: [{ id: "o", extensions: "rs", command, args: "--flag" }],
  });

  test("another command runs as written, on any toolchain, without installing", async () => {
    await addFiles({ "a.rs": "" });
    const own = await install(join(temp, "own/my-rustfmt"));
    const unusable: RustToolchain = { status: "none", rustupPath: null, detail: null };
    const { content } = await save("a.rs", unusable, overriding(own));
    expect(content).toStartWith(`${own} cwd=${wt} args=--flag install=0 toolchain=`);
  });

  test("rustfmt by name is the toolchain's", async () => {
    await addFiles({ "a.rs": "" });
    const rustfmt = await install(join(temp, "toolchain/bin/rustfmt"));
    const { content } = await save("a.rs", active({ rustfmt }), overriding("rustfmt"));
    expect(content).toStartWith(`${rustfmt} cwd=${wt} args=--flag `);
  });
});

describe("the registered module", () => {
  test("is listed, and the root rule it replaced is gone", async () => {
    await addFiles({ "rustfmt.toml": "" });
    expect(languageFormatters).toContain(rustFormatter);
    expect(new FormatService([]).getDetectedFormatters(wt)).toEqual([]);
    expect(new FormatService([rustFormatter]).getDetectedFormatters(wt)).toEqual([
      { command: "rustfmt", extensions: ["rs"] },
    ]);
  });

  test("runs through the real resolution", async () => {
    // An install without rustup, all fake: only this bin directory can answer.
    const home = join(temp, "home");
    process.env.PATH = bin;
    process.env.HOME = home;
    process.env.CARGO_HOME = join(home, ".cargo");
    delete process.env.RUSTUP_TOOLCHAIN;
    // The resolution's trust check runs git.
    if (GIT) await symlink(GIT, join(bin, "git"));
    await install(join(bin, "rustc"), '#!/bin/sh\necho "rustc 1.99.0 (abc 2026-01-01)"\n');
    const rustfmt = await install(join(bin, "rustfmt"));
    await addFiles({ "Cargo.toml": '[package]\nedition = "2024"\n', "src/a.rs": "" });
    const { content } = await new FormatService([rustFormatterWith(NO_DEADLINE_MS)]).format(
      "fn main() {}\n",
      join(wt, "src/a.rs"),
      wt,
      DEFAULT_FORMATTING_SETTINGS,
    );
    expect(content).toStartWith(`${rustfmt} cwd=${wt} args=--edition 2024 install=0 `);
  });
});
