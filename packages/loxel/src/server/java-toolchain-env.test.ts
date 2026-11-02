import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const root = realpathSync(mkdtempSync(join(tmpdir(), "java-toolchain-env-")));
// Overrides and trust live in the store database; keep the tests' state out of the real one.
process.env.LOXEL_STATE_DIR = join(root, "state");
const { javaToolchainEnv } = await import("./java-toolchain-env");
const { setJavaOverride } = await import("./java-override-store");
const { getRepoTrustStatus, setRepoTrusted } = await import("./repo-trust");
const { commitToolchainEnvChange } = await import("./toolchain-env-contributor");
type SpawnEnv = import("./toolchain-env-contributor").SpawnEnv;

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeJdk(home: string): string {
  mkdirSync(join(home, "bin"), { recursive: true });
  mkdirSync(join(home, "lib"), { recursive: true });
  for (const tool of ["java", "javac"]) {
    writeFileSync(join(home, "bin", tool), "#!/bin/sh\n");
    chmodSync(join(home, "bin", tool), 0o755);
  }
  writeFileSync(join(home, "lib", "ct.sym"), "");
  writeFileSync(join(home, "release"), 'JAVA_VERSION="21.0.5"\n');
  return home;
}

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

let worktrees = 0;

function makeWorktree(): string {
  const wt = join(root, `wt-${++worktrees}`);
  mkdirSync(wt, { recursive: true });
  git(wt, "init", "-q");
  return wt;
}

/** What a new shell's resolution makes of `env`, through the same commit a terminal uses. */
async function applied(wt: string, env: SpawnEnv): Promise<SpawnEnv> {
  const result = { ...env };
  const change = await javaToolchainEnv.resolveForTerminal(wt);
  if (!change) return result;
  const changed = { ...result };
  await change(changed, "/bin/sh");
  commitToolchainEnvChange(result, changed);
  return result;
}

const outsideJdk = makeJdk(join(root, "jdks", "chosen"));
const inherited = { JAVA_HOME: "/users/own/jdk", PATH: "/usr/bin" };

describe("javaToolchainEnv", () => {
  test("a chosen JDK sets JAVA_HOME and goes first on PATH, moved rather than duplicated", async () => {
    const wt = makeWorktree();
    setJavaOverride(wt, outsideJdk);
    const bin = join(outsideJdk, "bin");
    expect(
      await applied(wt, { JAVA_HOME: "/stale", PATH: ["/usr/bin", bin].join(delimiter) }),
    ).toEqual({ JAVA_HOME: outsideJdk, PATH: [bin, "/usr/bin"].join(delimiter) });
  });

  test("without a choice the shell keeps what it has, however many JDKs exist", async () => {
    const wt = makeWorktree();
    writeFileSync(join(wt, "pom.xml"), "<project/>");
    writeFileSync(join(wt, "Main.java"), "class Main {}");
    expect(await javaToolchainEnv.resolveForTerminal(wt)).toBeNull();
  });

  test("a chosen JDK that is gone changes nothing, and a stale JAVA_HOME stays", async () => {
    const wt = makeWorktree();
    setJavaOverride(wt, join(root, "jdks", "removed"));
    expect(await javaToolchainEnv.resolveForTerminal(wt)).toBeNull();
  });

  test("a chosen JDK inside the worktree counts only in a trusted repository", async () => {
    const wt = makeWorktree();
    writeFileSync(join(wt, ".gitignore"), ".jdk/\n");
    const home = makeJdk(join(wt, ".jdk"));
    setJavaOverride(wt, home);
    expect(await applied(wt, inherited)).toEqual(inherited);
    expect(getRepoTrustStatus(wt).restrictions).toHaveLength(1);

    setRepoTrusted(wt, true);
    expect((await applied(wt, inherited)).JAVA_HOME).toBe(home);
  });

  test("a chosen path outside the worktree that leads into it counts as inside", async () => {
    const wt = makeWorktree();
    writeFileSync(join(wt, ".gitignore"), ".jdk/\n");
    const home = makeJdk(join(wt, ".jdk"));
    const link = join(root, `link-${worktrees}`);
    symlinkSync(home, link);
    setJavaOverride(wt, link);
    expect(await applied(wt, inherited)).toEqual(inherited);
  });

  test("a chosen JDK whose bin leads into the worktree counts as inside", async () => {
    const wt = makeWorktree();
    writeFileSync(join(wt, ".gitignore"), ".jdk/\n");
    const inside = makeJdk(join(wt, ".jdk"));
    const outer = join(root, "jdks", `outer-${worktrees}`);
    mkdirSync(outer, { recursive: true });
    symlinkSync(join(inside, "bin"), join(outer, "bin"));
    symlinkSync(join(inside, "lib"), join(outer, "lib"));
    writeFileSync(join(outer, "release"), 'JAVA_VERSION="21.0.5"\n');
    setJavaOverride(wt, outer);
    expect(await applied(wt, inherited)).toEqual(inherited);
    expect(getRepoTrustStatus(wt).restrictions).toHaveLength(1);
  });

  test("a chosen JDK with files git tracks is refused, even in a trusted repository", async () => {
    const wt = makeWorktree();
    const home = makeJdk(join(wt, "jdk"));
    git(wt, "add", "jdk");
    setJavaOverride(wt, home);
    setRepoTrusted(wt, true);
    expect(await applied(wt, inherited)).toEqual(inherited);
  });

  test("a JDK whose path PATH cannot hold is left out whole", async () => {
    const wt = makeWorktree();
    setJavaOverride(wt, makeJdk(join(root, "jdks", `a${delimiter}b`)));
    expect(await applied(wt, inherited)).toEqual(inherited);
  });

  test("a JDK whose path the shell would interpret is left out whole", async () => {
    const wt = makeWorktree();
    setJavaOverride(wt, makeJdk(join(root, "jdks", "a$(b)")));
    expect(await javaToolchainEnv.resolveForTerminal(wt)).not.toBeNull();
    expect(await applied(wt, inherited)).toEqual(inherited);
  });
});
