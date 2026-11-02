import { afterAll, afterEach, describe, expect, mock, setDefaultTimeout, test } from "bun:test";
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

// Each test spawns fake tools; on a loaded machine that takes far longer than the default.
setDefaultTimeout(120_000);

// The fakes here are scripts, which the lookup refuses; `rust-tool-shim.test.ts` covers that.
mock.module("./rust-tool-shim", () => ({ isVersionManagerShim: async () => false }));

// Choices live in the store database; keep the tests' state out of the real one.
const stateDir = await mkdtemp(join(tmpdir(), "rust-toolchain-env-state-"));
process.env.LOXEL_STATE_DIR = stateDir;
const { rustToolchainEnv } = await import("./rust-toolchain-env");
const { setRustChoice } = await import("./rust-toolchain-store");
const { toolchainEnvs } = await import("./toolchain-envs");

const CHOSEN = "1.85.0-aarch64-apple-darwin";
const GIT = Bun.which("git");
const originalPath = process.env.PATH;
const originalHome = process.env.HOME;
const originalRustupHome = process.env.RUSTUP_HOME;

let root: string | undefined;

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(async () => {
  restore("PATH", originalPath);
  restore("HOME", originalHome);
  restore("RUSTUP_HOME", originalRustupHome);
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

afterAll(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

async function writeExecutable(filePath: string, script: string): Promise<void> {
  await writeFile(filePath, script);
  await chmod(filePath, 0o755);
}

/** A worktree, with process.env pointing at an empty bin directory first and at empty homes. */
async function setup(): Promise<{ wt: string; bin: string; rustupHome: string; log: string }> {
  root = await realpath(await mkdtemp(join(tmpdir(), "rust-toolchain-env-")));
  const wt = join(root, "wt");
  const bin = join(root, "bin");
  const rustupHome = join(root, "rustup");
  await Promise.all([mkdir(wt), mkdir(bin), mkdir(rustupHome)]);
  // With git, which the check that the repository does not ship a toolchain needs.
  process.env.PATH = [bin, ...(GIT ? [dirname(GIT)] : [])].join(delimiter);
  process.env.HOME = join(root, "home");
  process.env.RUSTUP_HOME = rustupHome;
  return { wt, bin, rustupHome, log: join(root, "runs.log") };
}

/** A fake rustup with `installed` toolchains, whose `rustc` is a link to it, logging each run. */
async function installRustup(
  { bin, rustupHome, log }: { bin: string; rustupHome: string; log: string },
  installed: string[],
): Promise<void> {
  const toolchains = join(rustupHome, "toolchains");
  await Promise.all(
    installed.map(async (name) => {
      await mkdir(join(toolchains, name, "bin"), { recursive: true });
      await writeExecutable(
        join(toolchains, name, "bin", "rustc"),
        `#!/bin/sh\necho "rustc ${name.split("-")[0]} (fake)"\n`,
      );
    }),
  );
  const list = installed.map((name) => `${name} ${join(toolchains, name)}`).join("\n");
  await writeExecutable(
    join(bin, "rustup"),
    `#!/bin/sh
echo "$*" >> "${log}"
case "$1 $2" in
  "--version "*) echo "rustup 1.29.0 (fake)" ;;
  "toolchain list") printf '%s\\n' "${list}" ;;
  "show active-toolchain") echo "$RUSTUP_TOOLCHAIN (overridden by RUSTUP_TOOLCHAIN)" ;;
  "which rustc") echo "${toolchains}/$RUSTUP_TOOLCHAIN/bin/rustc" ;;
  *) exit 1 ;;
esac
`,
  );
  // The lookup knows a proxy by being the same file as the rustup next to it.
  await link(join(bin, "rustup"), join(bin, "rustc"));
}

async function runs(log: string): Promise<string> {
  return readFile(log, "utf8").catch(() => "");
}

describe("rustToolchainEnv", () => {
  test("is listed among the terminal contributors", () => {
    expect(toolchainEnvs).toContain(rustToolchainEnv);
  });

  test("changes nothing and runs nothing without a choice", async () => {
    const fixture = await setup();
    await installRustup(fixture, [CHOSEN]);
    expect(await rustToolchainEnv.resolveForTerminal(fixture.wt)).toBeNull();
    expect(await runs(fixture.log)).toBe("");
  });

  test("sets the choice and nothing else, over an inherited RUSTUP_TOOLCHAIN", async () => {
    const fixture = await setup();
    await installRustup(fixture, [CHOSEN]);
    setRustChoice(fixture.wt, CHOSEN);
    const change = await rustToolchainEnv.resolveForTerminal(fixture.wt);
    const env = { PATH: `/usr/bin${delimiter}/bin`, HOME: "/h", RUSTUP_TOOLCHAIN: "stable" };
    await change?.(env, "/bin/zsh");
    expect(env).toEqual({ PATH: `/usr/bin${delimiter}/bin`, HOME: "/h", RUSTUP_TOOLCHAIN: CHOSEN });
  });

  test("changes nothing when the chosen toolchain is no longer installed", async () => {
    const fixture = await setup();
    await installRustup(fixture, [CHOSEN]);
    setRustChoice(fixture.wt, "1.84.0-aarch64-apple-darwin");
    expect(await rustToolchainEnv.resolveForTerminal(fixture.wt)).toBeNull();
  });

  test("changes nothing when the worktree holds the chosen toolchain", async () => {
    const fixture = await setup();
    await installRustup(fixture, []);
    const linked = join(fixture.wt, "linked");
    await mkdir(join(linked, "bin"), { recursive: true });
    await writeExecutable(join(linked, "bin", "rustc"), "#!/bin/sh\nexit 1\n");
    await writeExecutable(
      join(fixture.bin, "rustup"),
      `#!/bin/sh
case "$1 $2" in
  "--version "*) echo "rustup 1.29.0 (fake)" ;;
  "toolchain list") echo "linked ${linked}" ;;
  *) exit 1 ;;
esac
`,
    );
    setRustChoice(fixture.wt, "linked");
    expect(await rustToolchainEnv.resolveForTerminal(fixture.wt)).toBeNull();
  });

  test("changes nothing on an install without rustup, whatever is stored", async () => {
    const { wt, bin } = await setup();
    await writeExecutable(
      join(bin, "rustc"),
      `#!/bin/sh
case "$1" in
  --version) echo "rustc 1.90.0 (fake)" ;;
  --print) echo "${bin}" ;;
esac
`,
    );
    setRustChoice(wt, CHOSEN);
    expect(await rustToolchainEnv.resolveForTerminal(wt)).toBeNull();
  });
});
