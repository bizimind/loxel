import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Each test spawns git and fake tools; on a loaded machine that takes far longer than the default.
setDefaultTimeout(120_000);

// Choices live in the store database; keep the tests' state out of the real one.
const stateDir = await mkdtemp(join(tmpdir(), "rust-toolchain-state-"));
process.env.LOXEL_STATE_DIR = stateDir;
const {
  getRustToolchain,
  getRustToolchainNow,
  listRustToolchains,
  parseActiveToolchain,
  parseToolchainList,
  refreshAllRustToolchains,
  refreshRustToolchain,
  resolveRustToolchain,
  rustChosenEnv,
  rustToolEnv,
  subscribeRustToolchain,
  watchRustToolchain,
} = await import("./rust-toolchain");
const { getRustChoice, onRustChoiceChange, setRustChoice } = await import("./rust-toolchain-store");

const STABLE = "stable-aarch64-apple-darwin";
const PINNED = "1.90.0-aarch64-apple-darwin";

let root: string | undefined;

afterAll(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function writeExecutable(filePath: string, script: string): Promise<string> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, script);
  await chmod(filePath, 0o755);
  return filePath;
}

interface Fixture {
  root: string;
  wt: string;
  bin: string;
  rustupHome: string;
  /** Every fake `rustup` and `rustc` run: `AUTO_INSTALL|TOOLCHAIN|cwd|args`. */
  log: string;
  env: Record<string, string>;
  runs(): Promise<string[]>;
}

async function makeFixture(): Promise<Fixture> {
  root = await realpath(await mkdtemp(join(tmpdir(), "rust-toolchain-")));
  const wt = join(root, "wt");
  const bin = join(root, "bin");
  const rustupHome = join(root, "rustup");
  await Promise.all([
    mkdir(wt),
    mkdir(bin),
    mkdir(join(rustupHome, "toolchains"), { recursive: true }),
  ]);
  const log = join(root, "runs.log");
  return {
    root,
    wt,
    bin,
    rustupHome,
    log,
    env: { PATH: bin, HOME: join(root, "home"), RUSTUP_HOME: rustupHome },
    runs: async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n"),
  };
}

const logLine = (log: string) =>
  `echo "$RUSTUP_AUTO_INSTALL|$RUSTUP_TOOLCHAIN|$PWD|$0 $*" >> "${log}"`;

/** A toolchain directory whose `rustc` answers `--version` and records that it ran. */
async function makeToolchain(
  fixture: Fixture,
  dir: string,
  version: string,
  { tools = ["cargo", "rustfmt", "cargo-clippy"], rustSrc = false } = {},
): Promise<string> {
  await writeExecutable(
    join(dir, "bin", "rustc"),
    `#!/bin/sh\n${logLine(fixture.log)}\necho "rustc ${version} (abc 2026-01-01)"\n`,
  );
  for (const tool of tools) await writeExecutable(join(dir, "bin", tool), "#!/bin/sh\n");
  await mkdir(join(dir, "lib", "rustlib"), { recursive: true });
  if (rustSrc)
    await mkdir(join(dir, "lib", "rustlib", "src", "rust", "library"), { recursive: true });
  return dir;
}

/**
 * A fake rustup with `rustc` and `cargo` proxies linked to it, answering like rustup 1.29: the
 * chosen `RUSTUP_TOOLCHAIN`, else `active`. `active` is a toolchain name or the error rustup prints.
 */
async function makeRustup(
  fixture: Fixture,
  {
    active,
    activeReason = "default",
    installed = {},
    version = "1.29.2",
    gate,
  }: {
    /** `show active-toolchain` waits for this file, holding a resolution open. */
    gate?: string;
    active: string | { error: string };
    activeReason?: string;
    installed?: Record<string, string>;
    version?: string;
  },
): Promise<string> {
  const listLines = Object.entries(installed).map(([name, dir]) => `${name} ${dir}`);
  const activeName = typeof active === "string" ? active : "";
  const whichDir = typeof active === "string" ? (installed[active] ?? active) : "";
  const script = `#!/bin/sh
${logLine(fixture.log)}
case "$1 $2" in
  "--version "*) echo "rustup ${version} (abc 2026-10-21)"
    echo "info: This is the version for the rustup toolchain manager, not the rustc compiler." >&2 ;;
  "toolchain list") ${listLines.map((line) => `echo "${line}"`).join("; ") || ":"} ;;
  "show active-toolchain")
    ${gate ? `while [ ! -e "${gate}" ]; do sleep 0.01; done` : ":"}
    if [ -n "$RUSTUP_TOOLCHAIN" ]; then echo "$RUSTUP_TOOLCHAIN (overridden by environment variable RUSTUP_TOOLCHAIN)"; exit 0; fi
    ${
      typeof active === "string"
        ? `echo "${activeName} (${activeReason})"`
        : `echo "${active.error}" >&2; exit 1`
    } ;;
  "which rustc")
    if [ -n "$RUSTUP_TOOLCHAIN" ]; then case "$RUSTUP_TOOLCHAIN" in
      ${Object.entries(installed)
        .map(([name, dir]) => `"${name}") echo "${dir}/bin/rustc"; exit 0 ;;`)
        .join("\n      ")}
    esac; fi
    echo "${whichDir}/bin/rustc" ;;
  "which rust-analyzer")
    rustc="$("$0" which rustc)"
    analyzer="\${rustc%/*}/rust-analyzer"
    if [ -x "$analyzer" ]; then echo "$analyzer"; else
      echo "error: unknown binary 'rust-analyzer' in toolchain" >&2; exit 1
    fi ;;
  *) echo "error: unexpected command: $*" >&2; exit 1 ;;
esac
`;
  const rustup = await writeExecutable(join(fixture.bin, "rustup"), script);
  await symlink("rustup", join(fixture.bin, "rustc"));
  await symlink("rustup", join(fixture.bin, "cargo"));
  await symlink("rustup", join(fixture.bin, "rustfmt"));
  await symlink("rustup", join(fixture.bin, "cargo-clippy"));
  await symlink("rustup", join(fixture.bin, "rust-analyzer"));
  return rustup;
}

function track(wt: string, ...paths: string[]): void {
  Bun.spawnSync(["git", "-C", wt, "init", "-q"]);
  Bun.spawnSync(["git", "-C", wt, "add", ...paths]);
}

describe("reading rustup's output", () => {
  test("the active toolchain, and why", () => {
    expect(parseActiveToolchain(`${STABLE} (default)\n`, "")).toEqual({
      kind: "active",
      name: STABLE,
      source: "default",
      toolchainFile: null,
    });
    expect(
      parseActiveToolchain(`${PINNED} (overridden by '/p q/rust-toolchain.toml')\n`, ""),
    ).toEqual({
      kind: "active",
      name: PINNED,
      source: "toolchain-file",
      toolchainFile: "/p q/rust-toolchain.toml",
    });
    expect(
      parseActiveToolchain(`${PINNED} (overridden by environment variable RUSTUP_TOOLCHAIN)\n`, ""),
    ).toMatchObject({ source: "environment" });
    expect(parseActiveToolchain(`${PINNED} (directory override for '/p')\n`, "")).toMatchObject({
      source: "directory-override",
    });
  });

  test("errors naming an uninstalled toolchain", () => {
    expect(
      parseActiveToolchain(
        "",
        "error: override toolchain '1.70.0-x' is not installed: the toolchain file at '/w/rust-toolchain.toml' specifies an uninstalled toolchain\n",
      ),
    ).toEqual({
      kind: "not-installed",
      name: "1.70.0-x",
      source: "toolchain-file",
      toolchainFile: "/w/rust-toolchain.toml",
    });
    expect(
      parseActiveToolchain(
        "",
        "error: override toolchain '1.70.0-x' is not installed: the RUSTUP_TOOLCHAIN environment variable specifies an uninstalled toolchain\n",
      ),
    ).toMatchObject({ kind: "not-installed", source: "environment" });
    expect(
      parseActiveToolchain(
        "",
        "error: override toolchain '1.70.0-x' is not installed: the default toolchain does not describe an installed toolchain\n",
      ),
    ).toMatchObject({ kind: "not-installed", source: "default" });
  });

  test("a path toolchain's name can hold parentheses", () => {
    expect(
      parseActiveToolchain("/x/my (tc) dir (overridden by '/x (y)/rust-toolchain.toml')\n", ""),
    ).toEqual({
      kind: "active",
      name: "/x/my (tc) dir",
      source: "toolchain-file",
      toolchainFile: "/x (y)/rust-toolchain.toml",
    });
  });

  test("lines it does not recognize do not throw", () => {
    expect(parseActiveToolchain("", "error: no active toolchain\n")).toEqual({
      kind: "none",
      detail: null,
    });
    expect(parseActiveToolchain("", "error: relative path toolchain './tc'\n")).toEqual({
      kind: "none",
      detail: "relative path toolchain './tc'",
    });
    expect(parseActiveToolchain("", "")).toEqual({ kind: "none", detail: null });
    expect(parseActiveToolchain("something new\n", "")).toEqual({
      kind: "active",
      name: "something new",
      source: "unknown",
      toolchainFile: null,
    });
    expect(parseActiveToolchain("x (some new reason)\n", "")).toMatchObject({ source: "unknown" });
  });

  test("the toolchain list", () => {
    expect(
      parseToolchainList(
        [
          `${STABLE} (active, default) /r/toolchains/${STABLE}`,
          `${PINNED} /r/with space/${PINNED}`,
          "no installed toolchains",
          "warn: something else",
          "",
        ].join("\n"),
      ),
    ).toEqual([
      { name: STABLE, path: `/r/toolchains/${STABLE}` },
      { name: PINNED, path: `/r/with space/${PINNED}` },
    ]);
  });
});

describe("resolveRustToolchain", () => {
  test("finds rustup's default toolchain, its version and tools", async () => {
    const fixture = await makeFixture();
    const dir = await makeToolchain(fixture, join(fixture.root, "tc", STABLE), "1.99.1", {
      tools: ["cargo", "rustfmt"],
      rustSrc: true,
    });
    await makeRustup(fixture, { active: STABLE, installed: { [STABLE]: dir } });

    const toolchain = await resolveRustToolchain(fixture.wt, { chosen: null, env: fixture.env });

    expect(toolchain).toEqual({
      status: "active",
      source: "default",
      name: STABLE,
      version: "1.99.1",
      rustcPath: join(dir, "bin", "rustc"),
      sysroot: dir,
      toolchainFile: null,
      tools: {
        // The proxies, which honor the worktree's toolchain.
        cargo: join(fixture.bin, "cargo"),
        rustfmt: join(fixture.bin, "rustfmt"),
        // The proxy exists, but this toolchain does not have the component.
        cargoClippy: null,
        rustAnalyzer: null,
        rustSrc: true,
      },
    });
  });

  test("runs every command with RUSTUP_AUTO_INSTALL=0", async () => {
    const fixture = await makeFixture();
    const dir = await makeToolchain(fixture, join(fixture.root, "tc", STABLE), "1.99.1");
    await makeRustup(fixture, { active: STABLE, installed: { [STABLE]: dir } });

    await resolveRustToolchain(fixture.wt, { chosen: STABLE, env: fixture.env });
    await listRustToolchains(fixture.wt, { env: fixture.env });

    const runs = await fixture.runs();
    expect(runs.length).toBeGreaterThan(3);
    for (const run of runs) expect(run.startsWith("0|")).toBe(true);
  });

  test("a pinned toolchain that is not installed is reported, never asked about further", async () => {
    const fixture = await makeFixture();
    const file = join(fixture.wt, "rust-toolchain.toml");
    await makeRustup(fixture, {
      active: {
        error: `error: override toolchain '1.70.0-x' is not installed: the toolchain file at '${file}' specifies an uninstalled toolchain`,
      },
    });

    expect(await resolveRustToolchain(fixture.wt, { chosen: null, env: fixture.env })).toEqual({
      status: "not-installed",
      source: "toolchain-file",
      name: "1.70.0-x",
      toolchainFile: file,
    });
    expect((await fixture.runs()).some((run) => run.includes("which"))).toBe(false);
  });

  test("a toolchain file's reason names the file", async () => {
    const fixture = await makeFixture();
    const dir = await makeToolchain(fixture, join(fixture.root, "tc", PINNED), "1.90.0");
    const file = join(fixture.wt, "rust-toolchain.toml");
    await makeRustup(fixture, {
      active: PINNED,
      activeReason: `overridden by '${file}'`,
      installed: { [PINNED]: dir },
    });

    expect(
      await resolveRustToolchain(fixture.wt, { chosen: null, env: fixture.env }),
    ).toMatchObject({
      status: "active",
      source: "toolchain-file",
      name: PINNED,
      version: "1.90.0",
      toolchainFile: file,
    });
  });

  test("a chosen toolchain beats the file and becomes RUSTUP_TOOLCHAIN", async () => {
    const fixture = await makeFixture();
    const stable = await makeToolchain(fixture, join(fixture.root, "tc", STABLE), "1.99.1");
    const pinned = await makeToolchain(fixture, join(fixture.root, "tc", PINNED), "1.90.0");
    await makeRustup(fixture, {
      active: PINNED,
      activeReason: `overridden by '${join(fixture.wt, "rust-toolchain.toml")}'`,
      installed: { [STABLE]: stable, [PINNED]: pinned },
    });

    const toolchain = await resolveRustToolchain(fixture.wt, { chosen: STABLE, env: fixture.env });

    expect(toolchain).toMatchObject({
      status: "active",
      source: "chosen",
      name: STABLE,
      version: "1.99.1",
    });
    expect(rustChosenEnv(toolchain)).toEqual({ RUSTUP_TOOLCHAIN: STABLE });
    expect(rustToolEnv(toolchain)).toEqual({ RUSTUP_AUTO_INSTALL: "0", RUSTUP_TOOLCHAIN: STABLE });
  });

  test("a chosen toolchain no longer installed falls back, and never reaches a process", async () => {
    const fixture = await makeFixture();
    const stable = await makeToolchain(fixture, join(fixture.root, "tc", STABLE), "1.99.1");
    await makeRustup(fixture, { active: STABLE, installed: { [STABLE]: stable } });

    const toolchain = await resolveRustToolchain(fixture.wt, { chosen: PINNED, env: fixture.env });

    expect(toolchain).toMatchObject({ status: "active", source: "default", name: STABLE });
    expect(rustChosenEnv(toolchain)).toEqual({});
    expect(rustToolEnv(toolchain)).toEqual({ RUSTUP_AUTO_INSTALL: "0" });
    for (const run of await fixture.runs()) expect(run.split("|")[1]).toBe("");
  });

  test("the terminal part of the environment leaves rustup's auto-install alone", async () => {
    const fixture = await makeFixture();
    const stable = await makeToolchain(fixture, join(fixture.root, "tc", STABLE), "1.99.1");
    await makeRustup(fixture, { active: STABLE, installed: { [STABLE]: stable } });

    const toolchain = await resolveRustToolchain(fixture.wt, { chosen: STABLE, env: fixture.env });

    expect(rustChosenEnv(toolchain)).not.toHaveProperty("RUSTUP_AUTO_INSTALL");
  });

  test("a Rust without rustup resolves through rustc, with its tools on PATH", async () => {
    const fixture = await makeFixture();
    const sysroot = join(fixture.root, "cellar");
    await mkdir(join(sysroot, "lib", "rustlib", "src", "rust", "library"), { recursive: true });
    const rustc = await writeExecutable(
      join(fixture.bin, "rustc"),
      `#!/bin/sh\nif [ "$1" = "--print" ]; then echo "${sysroot}"; else echo "rustc 1.88.0 (Homebrew)"; fi\n`,
    );
    const cargo = await writeExecutable(join(fixture.bin, "cargo"), "#!/bin/sh\n");

    expect(await resolveRustToolchain(fixture.wt, { chosen: STABLE, env: fixture.env })).toEqual({
      status: "active",
      source: "no-rustup",
      name: null,
      version: "1.88.0",
      rustcPath: rustc,
      sysroot,
      toolchainFile: null,
      tools: { cargo, rustfmt: null, cargoClippy: null, rustAnalyzer: null, rustSrc: true },
    });
    expect(await listRustToolchains(fixture.wt, { env: fixture.env })).toEqual([]);
  });

  test("a rustc earlier on PATH than rustup's proxy is the one a terminal runs", async () => {
    const fixture = await makeFixture();
    const stable = await makeToolchain(fixture, join(fixture.root, "tc", STABLE), "1.99.1");
    await makeRustup(fixture, { active: STABLE, installed: { [STABLE]: stable } });
    const brew = join(fixture.root, "brew");
    const rustc = await writeExecutable(join(brew, "rustc"), `#!/bin/sh\necho "rustc 1.88.0"\n`);

    const toolchain = await resolveRustToolchain(fixture.wt, {
      chosen: null,
      env: { ...fixture.env, PATH: `${brew}:${fixture.bin}` },
    });

    expect(toolchain).toMatchObject({ source: "no-rustup", rustcPath: rustc, version: "1.88.0" });
  });

  test("finds rustup in $CARGO_HOME/bin, then ~/.cargo/bin, when PATH does not have it", async () => {
    const fixture = await makeFixture();
    const stable = await makeToolchain(fixture, join(fixture.root, "tc", STABLE), "1.99.1");
    await makeRustup(fixture, { active: STABLE, installed: { [STABLE]: stable } });
    const empty = join(fixture.root, "empty");
    await mkdir(empty);
    await mkdir(join(fixture.root, "cargo"));
    await symlink(fixture.bin, join(fixture.root, "cargo", "bin"));
    await mkdir(join(fixture.root, "home", ".cargo"), { recursive: true });
    await symlink(fixture.bin, join(fixture.root, "home", ".cargo", "bin"));

    const viaCargoHome = await resolveRustToolchain(fixture.wt, {
      chosen: null,
      env: { ...fixture.env, PATH: empty, CARGO_HOME: join(fixture.root, "cargo") },
    });
    expect(viaCargoHome).toMatchObject({ status: "active", name: STABLE });
    expect(viaCargoHome).toMatchObject({
      tools: { cargo: join(fixture.root, "cargo", "bin", "cargo") },
    });

    const viaHome = await resolveRustToolchain(fixture.wt, {
      chosen: null,
      env: { ...fixture.env, PATH: empty },
    });
    expect(viaHome).toMatchObject({
      tools: { cargo: join(fixture.root, "home", ".cargo", "bin", "cargo") },
    });
  });

  test("no Rust at all", async () => {
    const fixture = await makeFixture();
    expect(await resolveRustToolchain(fixture.wt, { chosen: null, env: fixture.env })).toEqual({
      status: "none",
      rustupPath: null,
      detail: null,
    });
  });

  test("rustup with no active toolchain", async () => {
    const fixture = await makeFixture();
    const rustup = await makeRustup(fixture, { active: { error: "error: no active toolchain" } });
    expect(await resolveRustToolchain(fixture.wt, { chosen: null, env: fixture.env })).toEqual({
      status: "none",
      rustupPath: rustup,
      detail: null,
    });
  });

  test("a rustup that ignores RUSTUP_AUTO_INSTALL is not run in the worktree", async () => {
    const fixture = await makeFixture();
    const rustup = await makeRustup(fixture, { active: STABLE, version: "1.27.1" });

    const toolchain = await resolveRustToolchain(fixture.wt, { chosen: null, env: fixture.env });

    expect(toolchain).toMatchObject({ status: "none", rustupPath: rustup });
    expect(toolchain).toHaveProperty("detail", expect.stringContaining("rustup self update"));
    const runs = await fixture.runs();
    expect(runs.length).toBe(1);
    expect(runs[0]).toContain("--version");
    expect(runs[0]).not.toContain(fixture.wt);
    expect(await listRustToolchains(fixture.wt, { env: fixture.env })).toEqual([]);
  });

  test("a rustup whose version cannot be read is not run in the worktree", async () => {
    const fixture = await makeFixture();
    await writeExecutable(
      join(fixture.bin, "rustup"),
      `#!/bin/sh\n${logLine(fixture.log)}\necho "garbled"\n`,
    );

    expect(
      await resolveRustToolchain(fixture.wt, { chosen: null, env: fixture.env }),
    ).toMatchObject({ status: "none", detail: expect.stringContaining("version") });
    expect((await fixture.runs()).length).toBe(1);
  });

  test("a rustup proxy is never run as a plain rustc, whichever rustup comes first", async () => {
    const fixture = await makeFixture();
    const stable = await makeToolchain(fixture, join(fixture.root, "tc", STABLE), "1.99.1");
    // The proxy's own rustup is old; another, newer, comes first on PATH.
    await makeRustup(fixture, {
      active: STABLE,
      installed: { [STABLE]: stable },
      version: "1.27.1",
    });
    const other = await writeExecutable(
      join(fixture.root, "other", "rustup"),
      `#!/bin/sh\necho "rustup 1.29.2 (abc)"\n`,
    );

    const toolchain = await resolveRustToolchain(fixture.wt, {
      chosen: null,
      env: { ...fixture.env, PATH: `${dirname(other)}:${fixture.bin}` },
    });

    expect(toolchain).toMatchObject({ status: "none", rustupPath: join(fixture.bin, "rustup") });
    expect(
      (await fixture.runs()).filter((run) => run.includes(" rustc") || run.includes("/rustc")),
    ).toEqual([]);
  });

  test("a rustup proxy without a rustup beside it runs nothing", async () => {
    const fixture = await makeFixture();
    const init = await writeExecutable(
      join(fixture.root, "elsewhere", "rustup-init"),
      `#!/bin/sh\n${logLine(fixture.log)}\necho "rustc 9.9.9"\n`,
    );
    await symlink(init, join(fixture.bin, "rustc"));

    const toolchain = await resolveRustToolchain(fixture.wt, { chosen: null, env: fixture.env });

    expect(toolchain).toMatchObject({ status: "none", rustupPath: null });
    expect(toolchain).toHaveProperty("detail", expect.stringContaining("rustup proxy"));
    expect(await Bun.file(fixture.log).exists()).toBe(false);
  });

  test("a proxy next to a tracked rustup runs nothing", async () => {
    const fixture = await makeFixture();
    const committed = join(fixture.wt, "tools");
    await writeExecutable(join(committed, "rustup"), `#!/bin/sh\n${logLine(fixture.log)}\n`);
    await symlink("rustup", join(committed, "rustc"));
    track(fixture.wt, "tools");
    const copy = join(fixture.root, "copy");
    await mkdir(copy);
    await symlink(join(committed, "rustup"), join(copy, "rustc"));

    const toolchain = await resolveRustToolchain(fixture.wt, {
      chosen: null,
      env: { ...fixture.env, PATH: `${copy}:${committed}` },
    });

    expect(toolchain).toMatchObject({ status: "none", rustupPath: null });
    expect(await Bun.file(fixture.log).exists()).toBe(false);
  });

  test("asks the rustup version without a toolchain it could run", async () => {
    const fixture = await makeFixture();
    const script = `#!/bin/sh
echo "HOME=$RUSTUP_HOME" >> "${fixture.log}"
echo "rustup 1.29.2 (abc)"
echo "error: no active toolchain" >&2
exit 1
`;
    await writeExecutable(join(fixture.bin, "rustup"), script);

    await resolveRustToolchain(fixture.wt, { chosen: null, env: fixture.env });

    const [first] = await fixture.runs();
    expect(first).toStartWith("HOME=");
    expect(first).not.toBe(`HOME=${fixture.rustupHome}`);
  });
});

describe("rust-analyzer", () => {
  test("rustup's proxy does not count when the toolchain lacks the component", async () => {
    const fixture = await makeFixture();
    const dir = await makeToolchain(fixture, join(fixture.root, "tc", STABLE), "1.99.1");
    await makeRustup(fixture, { active: STABLE, installed: { [STABLE]: dir } });

    expect(
      await resolveRustToolchain(fixture.wt, { chosen: null, env: fixture.env }),
    ).toMatchObject({ status: "active", tools: { rustAnalyzer: null } });
    for (const run of await fixture.runs()) expect(run.startsWith("0|")).toBe(true);
  });

  test("is the proxy when the toolchain has the component, asked for the chosen toolchain", async () => {
    const fixture = await makeFixture();
    const stable = await makeToolchain(fixture, join(fixture.root, "tc", STABLE), "1.99.1");
    const pinned = await makeToolchain(fixture, join(fixture.root, "tc", PINNED), "1.90.0", {
      tools: ["cargo", "rust-analyzer"],
    });
    await makeRustup(fixture, {
      active: STABLE,
      installed: { [STABLE]: stable, [PINNED]: pinned },
    });

    const resolve = (chosen: string | null) =>
      resolveRustToolchain(fixture.wt, { chosen, env: fixture.env });
    expect(await resolve(PINNED)).toMatchObject({
      tools: { rustAnalyzer: join(fixture.bin, "rust-analyzer") },
    });
    expect(await resolve(null)).toMatchObject({ tools: { rustAnalyzer: null } });
  });

  test("is the toolchain's own when no proxy is found", async () => {
    const fixture = await makeFixture();
    const dir = await makeToolchain(fixture, join(fixture.root, "tc", STABLE), "1.99.1", {
      tools: ["rust-analyzer"],
    });
    await makeRustup(fixture, { active: STABLE, installed: { [STABLE]: dir } });
    await rm(join(fixture.bin, "rust-analyzer"));

    expect(
      await resolveRustToolchain(fixture.wt, { chosen: null, env: fixture.env }),
    ).toMatchObject({ tools: { rustAnalyzer: join(dir, "bin", "rust-analyzer") } });
  });

  test("a tracked rust-analyzer in a toolchain is unavailable", async () => {
    const fixture = await makeFixture();
    const dir = await makeToolchain(fixture, join(fixture.root, "tc", STABLE), "1.99.1");
    await writeExecutable(join(fixture.wt, "rust-analyzer"), "#!/bin/sh\n");
    await symlink(join(fixture.wt, "rust-analyzer"), join(dir, "bin", "rust-analyzer"));
    track(fixture.wt, "rust-analyzer");
    await makeRustup(fixture, { active: STABLE, installed: { [STABLE]: dir } });

    expect(
      await resolveRustToolchain(fixture.wt, { chosen: null, env: fixture.env }),
    ).toMatchObject({ status: "active", tools: { rustAnalyzer: null } });
  });

  test("without rustup it is the PATH binary, skipping a tracked one", async () => {
    const fixture = await makeFixture();
    await writeExecutable(join(fixture.bin, "rustc"), `#!/bin/sh\necho "rustc 1.88.0"\n`);
    const committed = join(fixture.wt, "bin");
    await writeExecutable(join(committed, "rust-analyzer"), "#!/bin/sh\n");
    track(fixture.wt, "bin");
    const real = await writeExecutable(join(fixture.bin, "rust-analyzer"), "#!/bin/sh\n");

    expect(
      await resolveRustToolchain(fixture.wt, {
        chosen: null,
        env: { ...fixture.env, PATH: `${committed}:${fixture.bin}` },
      }),
    ).toMatchObject({ source: "no-rustup", tools: { rustAnalyzer: real } });
  });
});

describe("the trust rule", () => {
  test("refuses a toolchain the repository tracks, and never runs it", async () => {
    const fixture = await makeFixture();
    const tracked = await makeToolchain(fixture, join(fixture.wt, "tc"), "9.9.9");
    const file = join(fixture.wt, "rust-toolchain.toml");
    await writeFile(file, `[toolchain]\npath = "${tracked}"\n`);
    track(fixture.wt, "tc");
    await makeRustup(fixture, { active: tracked, activeReason: `overridden by '${file}'` });

    const toolchain = await resolveRustToolchain(fixture.wt, { chosen: null, env: fixture.env });

    expect(toolchain).toEqual({
      status: "refused",
      name: tracked,
      toolchainFile: file,
      rustcPath: join(tracked, "bin", "rustc"),
    });
    expect((await fixture.runs()).filter((run) => run.includes(`${tracked}/bin/`))).toEqual([]);
    // Nothing to spawn, and no choice to pass.
    expect(rustChosenEnv(toolchain)).toEqual({});
  });

  test("a committed symlink to a toolchain counts as shipped", async () => {
    const fixture = await makeFixture();
    const outside = await makeToolchain(fixture, join(fixture.root, "outside"), "9.9.9");
    const link = join(fixture.wt, "tc");
    await symlink(outside, link);
    track(fixture.wt, "tc");
    await makeRustup(fixture, { active: link });

    expect(
      await resolveRustToolchain(fixture.wt, { chosen: null, env: fixture.env }),
    ).toMatchObject({ status: "refused" });
  });

  test("an untracked directory toolchain is the user's own and runs", async () => {
    const fixture = await makeFixture();
    const own = await makeToolchain(fixture, join(fixture.wt, "tc"), "1.80.0");
    Bun.spawnSync(["git", "-C", fixture.wt, "init", "-q"]);
    await makeRustup(fixture, { active: own });

    expect(
      await resolveRustToolchain(fixture.wt, { chosen: null, env: fixture.env }),
    ).toMatchObject({ status: "active", version: "1.80.0" });
  });

  test("a tracked tool of a trusted toolchain is unavailable", async () => {
    const fixture = await makeFixture();
    const dir = await makeToolchain(fixture, join(fixture.root, "tc", STABLE), "1.99.1", {
      tools: [],
    });
    await writeExecutable(join(fixture.wt, "cargo"), "#!/bin/sh\n");
    await symlink(join(fixture.wt, "cargo"), join(dir, "bin", "cargo"));
    track(fixture.wt, "cargo");
    await makeRustup(fixture, { active: STABLE, installed: { [STABLE]: dir } });

    expect(
      await resolveRustToolchain(fixture.wt, { chosen: null, env: fixture.env }),
    ).toMatchObject({ status: "active", tools: { cargo: null } });
  });

  test("a tracked rustc on PATH is skipped for the next hit", async () => {
    const fixture = await makeFixture();
    const committed = join(fixture.wt, "bin");
    await writeExecutable(
      join(committed, "rustc"),
      `#!/bin/sh\necho "rustc 9.9.9"\ntouch "${join(fixture.root, "RAN")}"\n`,
    );
    await writeExecutable(
      join(committed, "rustup"),
      `#!/bin/sh\ntouch "${join(fixture.root, "RAN")}"\n`,
    );
    track(fixture.wt, "bin");
    const real = await writeExecutable(
      join(fixture.bin, "rustc"),
      `#!/bin/sh\necho "rustc 1.88.0"\n`,
    );

    expect(
      await resolveRustToolchain(fixture.wt, {
        chosen: null,
        env: { ...fixture.env, PATH: `${committed}:${fixture.bin}` },
      }),
    ).toMatchObject({ status: "active", rustcPath: real, version: "1.88.0" });
    expect(await Bun.file(join(fixture.root, "RAN")).exists()).toBe(false);
  });

  test("a chosen toolchain beats a tracked toolchain file", async () => {
    const fixture = await makeFixture();
    const tracked = await makeToolchain(fixture, join(fixture.wt, "tc"), "9.9.9");
    const stable = await makeToolchain(fixture, join(fixture.root, "tc", STABLE), "1.99.1");
    track(fixture.wt, "tc");
    await makeRustup(fixture, { active: tracked, installed: { [STABLE]: stable } });

    expect(
      await resolveRustToolchain(fixture.wt, { chosen: STABLE, env: fixture.env }),
    ).toMatchObject({ status: "active", source: "chosen", name: STABLE });
  });

  test("a linked toolchain the repository tracks is neither offered nor usable", async () => {
    const fixture = await makeFixture();
    const tracked = await makeToolchain(fixture, join(fixture.wt, "tc"), "9.9.9");
    const stable = await makeToolchain(fixture, join(fixture.root, "tc", STABLE), "1.99.1");
    track(fixture.wt, "tc");
    await makeRustup(fixture, { active: STABLE, installed: { linked: tracked, [STABLE]: stable } });

    expect(await listRustToolchains(fixture.wt, { env: fixture.env })).toEqual([
      { name: STABLE, path: stable, version: "1.99.1" },
    ]);
    expect(
      await resolveRustToolchain(fixture.wt, { chosen: "linked", env: fixture.env }),
    ).toMatchObject({ source: "default", name: STABLE });
    expect((await fixture.runs()).filter((run) => run.includes(`${tracked}/bin/`))).toEqual([]);
  });
});

describe("the choice", () => {
  test("is stored per worktree and reports changes", async () => {
    const fixture = await makeFixture();
    const heard: string[] = [];
    const off = onRustChoiceChange((wtPath) => heard.push(wtPath));

    setRustChoice(fixture.wt, STABLE);
    expect(getRustChoice(fixture.wt)).toBe(STABLE);
    setRustChoice(fixture.wt, null);
    expect(getRustChoice(fixture.wt)).toBeNull();

    off();
    expect(heard).toEqual([fixture.wt, fixture.wt]);
  });
});

/** Run `act`, wait for the subscriber's next update, and return it. */
function nextUpdate<T>(subscribe: (listener: (update: T) => void) => () => void): Promise<T> {
  return new Promise((resolve) => {
    const off = subscribe((update) => {
      off();
      resolve(update);
    });
  });
}

describe("the shared resolution", () => {
  test("hears a choice taking effect, and goes back to resolving afresh when unsubscribed", async () => {
    const fixture = await makeFixture();
    const previous = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      RUSTUP_HOME: process.env.RUSTUP_HOME,
    };
    // Keeps git findable: the trust rule asks it, and counts a path it cannot ask about as tracked.
    Object.assign(process.env, fixture.env, { PATH: `${fixture.bin}:${previous.PATH}` });
    const stable = await makeToolchain(fixture, join(fixture.root, "tc", STABLE), "1.99.1");
    const pinned = await makeToolchain(fixture, join(fixture.root, "tc", PINNED), "1.90.0");
    await makeRustup(fixture, {
      active: STABLE,
      installed: { [STABLE]: stable, [PINNED]: pinned },
    });

    const updates: Array<{ first: boolean; changed: boolean; name: string | null }> = [];
    const off = subscribeRustToolchain(fixture.wt, ({ toolchain, first, changed }) =>
      updates.push({ first, changed, name: toolchain.status === "active" ? toolchain.name : null }),
    );
    try {
      expect(updates).toEqual([]);
      expect(await getRustToolchain(fixture.wt)).toMatchObject({ name: STABLE, source: "default" });

      setRustChoice(fixture.wt, PINNED);
      refreshRustToolchain(fixture.wt);
      expect(await getRustToolchain(fixture.wt)).toMatchObject({ name: PINNED, source: "chosen" });

      // The same answer again is not a change.
      const same = nextUpdate<{ changed: boolean }>((listener) =>
        subscribeRustToolchain(fixture.wt, listener),
      );
      refreshRustToolchain(fixture.wt);
      expect((await same).changed).toBe(false);

      expect(updates.map(({ first, changed, name }) => [first, changed, name])).toEqual(
        expect.arrayContaining([
          [true, true, STABLE],
          [false, true, PINNED],
        ]),
      );
    } finally {
      off();
      setRustChoice(fixture.wt, null);
      Object.assign(process.env, previous);
    }
    expect(
      await resolveRustToolchain(fixture.wt, { chosen: null, env: fixture.env }),
    ).toMatchObject({ name: STABLE });
  });
});

describe("the shared resolution's consistency", () => {
  async function withFixtureEnv(fixture: Fixture, run: () => Promise<void>): Promise<void> {
    const previous = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      RUSTUP_HOME: process.env.RUSTUP_HOME,
    };
    Object.assign(process.env, fixture.env, { PATH: `${fixture.bin}:${previous.PATH}` });
    try {
      await run();
    } finally {
      Object.assign(process.env, previous);
    }
  }

  test("getRustToolchainNow answers with the settled toolchain while a newer one runs", async () => {
    const fixture = await makeFixture();
    const gate = join(fixture.root, "gate");
    await writeFile(gate, "");
    const stable = await makeToolchain(fixture, join(fixture.root, "tc", STABLE), "1.99.1");
    await makeRustup(fixture, { active: STABLE, installed: { [STABLE]: stable }, gate });

    await withFixtureEnv(fixture, async () => {
      const off = subscribeRustToolchain(fixture.wt, () => {});
      try {
        await getRustToolchain(fixture.wt);
        await rm(gate);
        refreshRustToolchain(fixture.wt);

        // The gate is closed, so this can only be the settled answer.
        expect(await getRustToolchainNow(fixture.wt)).toMatchObject({ name: STABLE });

        await writeFile(gate, "");
        expect(await getRustToolchain(fixture.wt)).toMatchObject({ name: STABLE });
      } finally {
        off();
      }
    });
  });

  test("getRustToolchainNow does not answer with a settled toolchain of an older choice", async () => {
    const fixture = await makeFixture();
    const gate = join(fixture.root, "gate");
    await writeFile(gate, "");
    const stable = await makeToolchain(fixture, join(fixture.root, "tc", STABLE), "1.99.1");
    const pinned = await makeToolchain(fixture, join(fixture.root, "tc", PINNED), "1.90.0");
    await makeRustup(fixture, {
      active: STABLE,
      installed: { [STABLE]: stable, [PINNED]: pinned },
      gate,
    });

    await withFixtureEnv(fixture, async () => {
      const off = subscribeRustToolchain(fixture.wt, () => {});
      try {
        setRustChoice(fixture.wt, PINNED);
        expect(await getRustToolchain(fixture.wt)).toMatchObject({ source: "chosen" });
        await rm(gate);
        setRustChoice(fixture.wt, null);
        refreshRustToolchain(fixture.wt);

        const answer = getRustToolchainNow(fixture.wt);
        await writeFile(gate, "");
        expect(await answer).toMatchObject({ source: "default", name: STABLE });
      } finally {
        off();
        setRustChoice(fixture.wt, null);
      }
    });
  });

  test("a toolchain the repository starts tracking is withdrawn", async () => {
    const fixture = await makeFixture();
    const own = await makeToolchain(fixture, join(fixture.wt, "tc"), "1.80.0");
    Bun.spawnSync(["git", "-C", fixture.wt, "init", "-q"]);
    await makeRustup(fixture, { active: own });

    await withFixtureEnv(fixture, async () => {
      const off = subscribeRustToolchain(fixture.wt, () => {});
      try {
        expect(await getRustToolchain(fixture.wt)).toMatchObject({ status: "active" });
        Bun.spawnSync(["git", "-C", fixture.wt, "add", "tc"]);
        expect(await getRustToolchain(fixture.wt)).toMatchObject({ status: "refused" });
      } finally {
        off();
      }
    });
  });

  test("a login-shell change re-resolves only when it can change the result", async () => {
    const fixture = await makeFixture();
    const stable = await makeToolchain(fixture, join(fixture.root, "tc", STABLE), "1.99.1");
    await makeRustup(fixture, { active: STABLE, installed: { [STABLE]: stable } });

    await withFixtureEnv(fixture, async () => {
      const heard: boolean[] = [];
      const off = subscribeRustToolchain(fixture.wt, ({ first }) => heard.push(first));
      try {
        await getRustToolchain(fixture.wt);
        const showRuns = async () =>
          (await fixture.runs()).filter((run) => run.includes("show active-toolchain")).length;
        const before = await showRuns();

        refreshAllRustToolchains(["SSH_AGENT_PID"]);
        await getRustToolchain(fixture.wt);
        expect(await showRuns()).toBe(before);

        refreshAllRustToolchains(["RUSTUP_HOME"]);
        await getRustToolchain(fixture.wt);
        expect(await showRuns()).toBe(before + 1);
      } finally {
        off();
      }
    });
  });
});

describe("watchRustToolchain", () => {
  /**
   * Repeat `act` until the watch reports a change: FSEvents can drop events from the first moments
   * of a new watch, so one write proves nothing, and the test's own timeout bounds a watch that
   * never reports.
   */
  async function reportsChange(
    wt: string,
    current: Parameters<typeof watchRustToolchain>[1],
    env: Record<string, string>,
    act: (attempt: number) => Promise<void>,
  ): Promise<void> {
    const state = { reported: false };
    let changed!: () => void;
    const reported = new Promise<void>((resolve) => {
      changed = () => {
        state.reported = true;
        resolve();
      };
    });
    const watch = watchRustToolchain(wt, current, changed, { env, debounceMs: 1 });
    try {
      for (let attempt = 0; !state.reported; attempt++) {
        await act(attempt);
        await Promise.race([reported, Bun.sleep(25)]);
      }
    } finally {
      watch.close();
    }
  }

  test("reports a toolchain file appearing and changing", async () => {
    const fixture = await makeFixture();
    await reportsChange(fixture.wt, null, fixture.env, (attempt) =>
      writeFile(join(fixture.wt, "rust-toolchain.toml"), `# ${attempt}\n`),
    );
    await reportsChange(fixture.wt, null, fixture.env, (attempt) =>
      writeFile(join(fixture.wt, "rust-toolchain"), `1.${attempt}.0\n`),
    );
  });

  test("reports a toolchain installed and the default changed", async () => {
    const fixture = await makeFixture();
    await reportsChange(fixture.wt, null, fixture.env, async (attempt) => {
      await mkdir(join(fixture.rustupHome, "toolchains", `t${attempt}`));
    });
    await reportsChange(fixture.wt, null, fixture.env, (attempt) =>
      writeFile(join(fixture.rustupHome, "settings.toml"), `# ${attempt}\n`),
    );
  });

  test("reports rustup's first install through the deepest existing directory", async () => {
    const fixture = await makeFixture();
    const rustupHome = join(fixture.root, "not-yet", "rustup");
    await reportsChange(fixture.wt, null, { ...fixture.env, RUSTUP_HOME: rustupHome }, async () => {
      // Removed first, so a repeat is a new event if the watch missed the last one.
      await rm(join(fixture.root, "not-yet"), { recursive: true, force: true });
      await mkdir(join(fixture.root, "not-yet"));
    });
  });

  test("reports a component added to the current toolchain", async () => {
    const fixture = await makeFixture();
    const dir = await makeToolchain(fixture, join(fixture.root, "tc", STABLE), "1.99.1");
    const current = {
      status: "active",
      source: "default",
      name: STABLE,
      version: "1.99.1",
      rustcPath: join(dir, "bin", "rustc"),
      sysroot: dir,
      toolchainFile: null,
      tools: { cargo: null, rustfmt: null, cargoClippy: null, rustAnalyzer: null, rustSrc: false },
    } as const;
    await reportsChange(fixture.wt, current, fixture.env, (attempt) =>
      writeFile(join(dir, "lib", "rustlib", "components"), `rust-src ${attempt}\n`),
    );
  });

  test("reports Rust appearing on PATH while no toolchain exists", async () => {
    const fixture = await makeFixture();
    const none = { status: "none", rustupPath: null, detail: null } as const;
    await reportsChange(fixture.wt, none, fixture.env, async () => {
      await rm(join(fixture.bin, "rustc"), { force: true });
      await writeFile(join(fixture.bin, "rustc"), "");
    });
  });

  test("hasPendingChange follows nudge and the debounce", async () => {
    const fixture = await makeFixture();
    let fire!: () => void;
    const fired = new Promise<void>((resolve) => {
      fire = resolve;
    });
    const watch = watchRustToolchain(fixture.wt, null, fire, { env: fixture.env, debounceMs: 1 });
    try {
      expect(watch.hasPendingChange).toBe(false);
      watch.nudge();
      expect(watch.hasPendingChange).toBe(true);
      await fired;
      expect(watch.hasPendingChange).toBe(false);
    } finally {
      watch.close();
    }
  });
});
