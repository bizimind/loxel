import { afterEach, describe, expect, test } from "bun:test";
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
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import type { GoEnv } from "@/api/go-env-model";
import { repeatUntil } from "@/test/repeat-until";
import "@/test/temp-state-dir";

import {
  canChangeGoEnv,
  compareGoVersions,
  GO_ENV,
  getGoEnv,
  goSpawnEnv,
  goToolPath,
  refreshAllGoEnvs,
  subscribeGoEnv,
  trustedGoTool,
} from "./go-env";

const roots: string[] = [];
const cleanups: (() => void)[] = [];
const originalPath = process.env.PATH;
const originalHome = process.env.HOME;
const GIT = Bun.which("git");

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  process.env.PATH = originalPath;
  process.env.HOME = originalHome;
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

async function writeExecutable(file: string, script: string): Promise<void> {
  await writeFile(file, script);
  await chmod(file, 0o755);
}

/** Stands in for `go`: appends its arguments and environment to `log`, and reports `version`. */
const fakeGo = (version: string, log: string) => `#!/bin/sh
echo "$PWD|$*|$GOPROXY|$GOTOOLCHAIN|$GOSUMDB|$GONOPROXY" >> "${log}"
echo '{"GOVERSION":"go${version}","GOROOT":"/goroot","GOPATH":"/gopath","GOMODCACHE":"/gopath/pkg/mod","GOMOD":"/dev/null","GOWORK":"","GOFLAGS":"-mod=mod"}'
`;

async function setup(version = "1.27.3") {
  const wt = await makeDir("go-wt-");
  const bin = await makeDir("go-bin-");
  const log = join(await makeDir("go-log-"), "calls");
  await writeFile(log, "");
  process.env.HOME = await makeDir("go-home-");
  const gitDir = await makeDir("go-git-");
  await symlink(GIT ?? "git", join(gitDir, "git"));
  process.env.PATH = [bin, gitDir].join(delimiter);
  await writeExecutable(join(bin, "go"), fakeGo(version, log));
  const calls = async () => (await readFile(log, "utf8")).split("\n").filter(Boolean);
  return { wt, bin, log, gitDir, calls };
}

/** Calls `read` after each update of `wt` until it returns a value. */
function untilUpdate<T>(wt: string, read: (env: GoEnv | null) => T | undefined): Promise<T> {
  return new Promise((resolve) => {
    const unsubscribe = subscribeGoEnv(wt, ({ env }) => {
      const value = read(env);
      if (value !== undefined) resolve(value);
    });
    cleanups.push(unsubscribe);
  });
}

describe("getGoEnv", () => {
  test("is null without go", async () => {
    const { wt, bin } = await setup();
    await rm(join(bin, "go"));
    expect(await getGoEnv(wt)).toBeNull();
  });

  test("reports what go env says, asked offline in the worktree", async () => {
    const { wt, bin, calls } = await setup();
    expect(await getGoEnv(wt)).toEqual({
      binary: join(bin, "go"),
      source: "path",
      version: "1.27.3",
      goroot: "/goroot",
      gopath: "/gopath",
      gomodcache: "/gopath/pkg/mod",
      toolchainPlatform: null,
      gomod: null,
      gowork: null,
      goflags: "-mod=mod",
      gopls: null,
      newerGoNeeded: null,
      newerToolchainSuggested: null,
    });
    const offline = [GO_ENV.GOPROXY, GO_ENV.GOTOOLCHAIN, GO_ENV.GOSUMDB, GO_ENV.GONOPROXY];
    expect(await calls()).toEqual([
      `${wt}|env -json GOVERSION GOROOT GOPATH GOMODCACHE GOMOD GOWORK GOFLAGS GOHOSTOS GOHOSTARCH|${offline.join("|")}`,
    ]);
  });

  test("keeps a go that does not answer, without a version", async () => {
    const { wt, bin } = await setup();
    await writeExecutable(join(bin, "go"), "#!/bin/sh\nexit 3\n");
    expect(await getGoEnv(wt)).toMatchObject({ binary: join(bin, "go"), version: null });
    await writeExecutable(join(bin, "go"), "#!/bin/sh\necho not json\n");
    expect(await getGoEnv(wt)).toMatchObject({ binary: join(bin, "go"), version: null });
  });

  test("needs a newer Go for a newer go line, of whichever root file is highest", async () => {
    const { wt } = await setup();
    await writeFile(join(wt, "go.mod"), "module x\n\ngo 1.28.0 // comment\n");
    expect((await getGoEnv(wt))?.newerGoNeeded).toEqual({ file: "go.mod", version: "1.28.0" });
    await writeFile(join(wt, "go.work"), "go 1.29\n\nuse .\n");
    expect((await getGoEnv(wt))?.newerGoNeeded).toEqual({ file: "go.work", version: "1.29" });
  });

  test("only notes a newer toolchain line, which still loads", async () => {
    const { wt } = await setup();
    await writeFile(join(wt, "go.mod"), "module x\n\ngo 1.21\n\ntoolchain go1.99.1\n");
    const env = await getGoEnv(wt);
    expect(env?.newerGoNeeded).toBeNull();
    expect(env?.newerToolchainSuggested).toEqual({ file: "go.mod", version: "1.99.1" });
  });

  test("needs nothing for what is installed or older, or a line that is no version", async () => {
    const { wt } = await setup();
    for (const line of ["go 1.27.3", "go 1.27", "go 1.21.0\ntoolchain go1.27.3", "go latest"]) {
      await writeFile(join(wt, "go.mod"), `module x\n\n${line}\n`);
      const env = await getGoEnv(wt);
      expect(env?.newerGoNeeded).toBeNull();
      expect(env?.newerToolchainSuggested).toBeNull();
    }
  });

  test("looks at the root only: a nested module is out of scope", async () => {
    const { wt } = await setup();
    await mkdir(join(wt, "nested"));
    await writeFile(join(wt, "nested", "go.mod"), "module x\n\ngo 1.99\n");
    expect((await getGoEnv(wt))?.newerGoNeeded).toBeNull();
  });

  test("does not read a go.mod that is no regular file", async () => {
    const { wt } = await setup();
    await Bun.spawn(["mkfifo", join(wt, "go.mod")]).exited;
    await symlink("/dev/zero", join(wt, "go.work"));
    expect((await getGoEnv(wt))?.newerGoNeeded).toBeNull();
  });
});

describe("a version manager's shim", () => {
  /** A shim on the PATH before anything else, naming `goroot` and noting its runs. */
  async function setupShimIn(context: Awaited<ReturnType<typeof setup>>, goroot: string | null) {
    await rm(join(context.bin, "go"));
    const shims = join(await makeDir("go-manager-"), "shims");
    await mkdir(shims);
    const reported = goroot ? `"GOROOT":"${goroot}",` : "";
    await writeExecutable(
      join(shims, "go"),
      `#!/bin/sh\necho "shim $PWD" >> "${context.log}"\necho '{${reported}"GOVERSION":"go1.20.1"}'\n`,
    );
    process.env.PATH = [shims, context.bin, context.gitDir].join(delimiter);
    return { ...context, shims };
  }
  const setupShim = async (goroot: string | null) => setupShimIn(await setup(), goroot);

  test("runs only from the home directory, and the real Go runs in the worktree", async () => {
    const goroot = await makeDir("go-root-");
    await mkdir(join(goroot, "bin"));
    const { wt, shims, log, calls } = await setupShim(goroot);
    await writeExecutable(join(goroot, "bin", "go"), fakeGo("1.27.3", log));
    expect(await getGoEnv(wt)).toMatchObject({ binary: join(shims, "go"), version: "1.27.3" });
    const [first, second, ...rest] = await calls();
    expect(first).toBe(`shim ${homedir()}`);
    expect(second?.startsWith(`${wt}|env -json GOVERSION`)).toBe(true);
    expect(rest).toEqual([]);
  });

  test("counts as no go, and does not run in the worktree, when it names no GOROOT", async () => {
    const { wt, calls } = await setupShim(null);
    expect(await getGoEnv(wt)).toBeNull();
    expect(await calls()).toEqual([`shim ${homedir()}`]);
  });

  test("does not run the go of a GOROOT in the worktree", async () => {
    const context = await setup();
    const { wt, log, calls } = context;
    const goroot = join(wt, "goroot");
    await setupShimIn(context, goroot);
    await mkdir(join(goroot, "bin"), { recursive: true });
    await writeExecutable(join(goroot, "bin", "go"), fakeGo("1.27.3", log));
    expect(await getGoEnv(wt)).toBeNull();
    expect(await calls()).toEqual([`shim ${homedir()}`]);
  });

  test("is no tool to run in a worktree, and is left off what go can run", async () => {
    const { wt, shims, bin } = await setupShim("/goroot");
    await writeExecutable(join(shims, "gopls"), "#!/bin/sh\n");
    expect(await trustedGoTool(wt, "gopls")).toBeNull();
    const env = { binary: join(shims, "go"), goroot: "/goroot", source: "path" } as const;
    const dirs = goSpawnEnv(wt, env).PATH?.split(delimiter) ?? [];
    expect(dirs[0]).toBe(join("/goroot", "bin"));
    expect(dirs).toContain(bin);
    expect(dirs).not.toContain(shims);
  });

  test("a go that is no shim stays first, whatever GOROOT it reports", async () => {
    const { wt, bin } = await setup();
    const env = { binary: join(bin, "go"), goroot: "/stale", source: "path" } as const;
    expect(goSpawnEnv(wt, env).PATH?.split(delimiter)).not.toContain(join("/stale", "bin"));
  });
});

describe("goToolPath", () => {
  test("drops worktree directories, symlinks to them and relative entries", async () => {
    const { wt, bin, gitDir } = await setup();
    await mkdir(join(wt, "bin"));
    const link = join(await makeDir("go-link-"), "link");
    await symlink(join(wt, "bin"), link);
    process.env.PATH = [join(wt, "bin"), link, "bin", "../sibling", bin, gitDir].join(delimiter);
    const dirs = goToolPath(wt).split(delimiter);
    expect(dirs).toContain(bin);
    expect(dirs).toContain(gitDir);
    for (const refused of [join(wt, "bin"), link, "bin", "../sibling"]) {
      expect(dirs).not.toContain(refused);
    }
  });
});

describe("the user's gopls", () => {
  test("is named when found and trusted, and not when it is not", async () => {
    const { wt, bin } = await setup();
    expect((await getGoEnv(wt))?.gopls).toBeNull();
    await writeExecutable(join(bin, "gopls"), "#!/bin/sh\n");
    expect((await getGoEnv(wt))?.gopls).toBe(join(bin, "gopls"));
    await rm(join(bin, "gopls"));
    await writeExecutable(join(wt, "gopls"), "#!/bin/sh\n");
    await symlink(join(wt, "gopls"), join(bin, "gopls"));
    expect((await getGoEnv(wt))?.gopls).toBeNull();
  });
});

describe("trustedGoTool", () => {
  test("refuses a binary that is a symlink into the worktree", async () => {
    const { wt, bin } = await setup();
    await writeExecutable(join(wt, "gopls"), "#!/bin/sh\n");
    await symlink(join(wt, "gopls"), join(bin, "gopls"));
    expect(await trustedGoTool(wt, "gopls")).toBeNull();
  });

  test("refuses a binary that a repository tracks", async () => {
    const { wt, bin } = await setup();
    for (const dir of [wt, bin]) {
      await Bun.spawn(["git", "init", "-q"], { cwd: dir, env: process.env }).exited;
    }
    await writeExecutable(join(bin, "gopls"), "#!/bin/sh\n");
    await Bun.spawn(["git", "add", "gopls"], { cwd: bin, env: process.env }).exited;
    expect(await trustedGoTool(wt, "gopls")).toBeNull();
    await rm(join(bin, ".git"), { recursive: true });
    expect(await trustedGoTool(wt, "gopls")).toBe(join(bin, "gopls"));
  });
});

describe("subscribeGoEnv", () => {
  const TIMEOUT_MS = 30_000;

  test("memoizes while subscribed", async () => {
    const { wt } = await setup();
    cleanups.push(subscribeGoEnv(wt, () => {}));
    const [first, second] = await Promise.all([getGoEnv(wt), getGoEnv(wt)]);
    expect(first).not.toBeNull();
    expect(first).toBe(second);
  });

  test(
    "resolves again when the root go.mod changes",
    async () => {
      const { wt } = await setup();
      const needed = untilUpdate(wt, (env) => env?.newerGoNeeded?.version);
      await getGoEnv(wt);
      const version = await repeatUntil(needed, () =>
        writeFile(join(wt, "go.mod"), "module x\n\ngo 1.99\n"),
      );
      expect(version).toBe("1.99");
    },
    TIMEOUT_MS,
  );

  test(
    "notices go appearing in, changing in and leaving a PATH directory",
    async () => {
      const { wt, bin, log } = await setup();
      await rm(join(bin, "go"));
      const found = untilUpdate(wt, (env) => env?.version ?? undefined);
      expect(await getGoEnv(wt)).toBeNull();
      const install = (version: string) => writeExecutable(join(bin, "go"), fakeGo(version, log));
      expect(await repeatUntil(found, () => install("1.27.3"))).toBe("1.27.3");

      const swapped = untilUpdate(wt, (env) => (env?.version === "1.28.1" ? true : undefined));
      expect(await repeatUntil(swapped, () => install("1.28.1"))).toBe(true);

      const gone = untilUpdate(wt, (env) => (env === null ? true : undefined));
      await rm(join(bin, "go"));
      expect(await gone).toBe(true);
    },
    TIMEOUT_MS,
  );

  test(
    "notices a PATH directory that did not exist",
    async () => {
      const { wt, bin, log, gitDir } = await setup();
      const parent = join(bin, "later");
      const later = join(parent, "bin");
      process.env.PATH = [later, gitDir].join(delimiter);
      const found = untilUpdate(wt, (env) => env?.binary);
      await getGoEnv(wt);
      const binary = await repeatUntil(found, async () => {
        await rm(parent, { recursive: true, force: true });
        await mkdir(later, { recursive: true });
        await writeExecutable(join(later, "go"), fakeGo("1.27.3", log));
      });
      expect(binary).toBe(join(later, "go"));
    },
    TIMEOUT_MS,
  );

  test("says when a resolution changed nothing", async () => {
    const { wt } = await setup();
    const updates: boolean[] = [];
    const unchanged = new Promise<void>((resolve) => {
      cleanups.push(
        subscribeGoEnv(wt, ({ changed }) => {
          updates.push(changed);
          if (changed) refreshAllGoEnvs(["PATH"]);
          else resolve();
        }),
      );
    });
    await getGoEnv(wt);
    await unchanged;
    expect(updates[0]).toBe(true);
  });
});

describe("canChangeGoEnv", () => {
  test("is true for PATH and Go's variables, not for what startup files change on every run", () => {
    for (const name of ["PATH", "GOFLAGS", "GOROOT", "GOTOOLCHAIN"]) {
      expect(canChangeGoEnv(["SSH_AUTH_SOCK", name])).toBe(true);
    }
    expect(canChangeGoEnv(["SSH_AUTH_SOCK", "MYPATH"])).toBe(false);
  });
});

describe("compareGoVersions", () => {
  test("orders a language version before its pre-releases and releases", () => {
    const ordered = [
      "1.9",
      "1.21",
      "1.21beta1",
      "1.21rc1",
      "1.21rc2",
      "1.21.0",
      "1.21.1",
      "1.21.10",
      "2.0",
    ];
    for (const [i, version] of ordered.entries()) {
      expect(compareGoVersions(version, version)).toBe(0);
      const next = ordered[i + 1];
      if (!next) continue;
      expect(compareGoVersions(version, next)).toBeLessThan(0);
      expect(compareGoVersions(next, version)).toBeGreaterThan(0);
    }
  });
});
