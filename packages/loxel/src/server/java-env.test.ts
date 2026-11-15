import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { JavaEnv } from "@/api/java-env-model";
import { repeatUntil } from "@/test/repeat-until";

// JDK overrides live in the store database; keep the tests' state out of the real one.
const stateDir = await mkdtemp(join(tmpdir(), "java-env-state-"));
process.env.LOXEL_STATE_DIR = stateDir;
const {
  getJavaEnv,
  getJavaEnvResolution,
  isMacOsJavaStub,
  javaExecutable,
  javaInstallRoots,
  javaMajorVersion,
  javaWatchTargets,
  listJavaRuntimes,
  normalizeJavaOverride,
  parseJavaHomeList,
  parseReleaseFile,
  refreshAllJavaEnvs,
  refreshJavaEnv,
  resolveJavaEnv,
  subscribeJavaEnv,
  watchJavaEnv,
} = await import("./java-env");
const { getJavaOverride, setJavaOverride } = await import("./java-override-store");

let root = "";
let wt = "";
let home = "";
/** A file every fixture `java` and `javac` creates if something runs it. */
let ranMarker = "";

afterAll(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  delete process.env.JAVA_HOME;
});

async function setup(): Promise<void> {
  root = await realpath(await mkdtemp(join(tmpdir(), "java-env-")));
  wt = join(root, "wt");
  home = join(root, "home");
  ranMarker = join(root, "ran");
  await Promise.all([mkdir(wt), mkdir(home)]);
  Bun.spawnSync(["git", "-C", wt, "init", "-q"]);
}

async function writeExecutable(filePath: string, script: string): Promise<string> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, script);
  await chmod(filePath, 0o755);
  return filePath;
}

interface JdkFixture {
  version?: string;
  implementor?: string | null;
  javac?: boolean;
  /** Which class data it has: `ct.sym` is in every JDK, `jmods` not in JDK 25. */
  classData?: "ct.sym" | "jmods" | null;
  release?: boolean;
}

/** A directory laid out like a JDK home; defaults to a complete JDK 21 like Temurin's. */
async function makeJdk(jdkHome: string, fixture: JdkFixture = {}): Promise<string> {
  const { version = "21.0.5", implementor = "Eclipse Adoptium" } = fixture;
  const { javac = true, classData = "ct.sym", release = true } = fixture;
  const script = `#!/bin/sh\ntouch "${ranMarker}"\n`;
  await writeExecutable(join(jdkHome, "bin", "java"), script);
  if (javac) await writeExecutable(join(jdkHome, "bin", "javac"), script);
  await mkdir(join(jdkHome, "lib"), { recursive: true });
  if (classData === "ct.sym") await writeFile(join(jdkHome, "lib", "ct.sym"), "");
  if (classData === "jmods") await mkdir(join(jdkHome, "jmods"));
  if (release) {
    const lines = [`JAVA_VERSION="${version}"`, 'IMAGE_TYPE="JDK"'];
    if (implementor) lines.unshift(`IMPLEMENTOR="${implementor}"`);
    await writeFile(join(jdkHome, "release"), `${lines.join("\n")}\n`);
  }
  return jdkHome;
}

/** Nothing on this machine counts: no tool, no PATH, only the install roots the test names. */
function isolated(overrides: Parameters<typeof resolveJavaEnv>[1] = {}) {
  return {
    overridePath: null,
    javaHomeTool: null,
    installRoots: [],
    env: { PATH: "", HOME: home },
    ...overrides,
  };
}

function git(...args: string[]): void {
  Bun.spawnSync(["git", "-C", wt, ...args]);
}

describe("reading a JDK", () => {
  test("reads the version and implementor from the release file", async () => {
    await setup();
    const jdk = await makeJdk(join(root, "jdk"), { version: "17.0.13", implementor: "BellSoft" });
    const { env } = await resolveJavaEnv(wt, isolated({ env: { PATH: "", JAVA_HOME: jdk } }));
    expect(env).toEqual({
      source: "java-home",
      path: jdk,
      majorVersion: 17,
      version: "17.0.13",
      implementor: "BellSoft",
    });
  });

  test("takes a JDK with jmods and no ct.sym, or the other way around (JDK 25 has no jmods)", async () => {
    await setup();
    for (const classData of ["jmods", "ct.sym"] as const) {
      const jdk = await makeJdk(join(root, classData), { classData });
      const { env } = await resolveJavaEnv(wt, isolated({ overridePath: jdk }));
      expect(env?.path).toBe(jdk);
    }
  });

  test("a JRE, a jlink image, and a directory without a release file do not qualify", async () => {
    await setup();
    const negatives = [
      await makeJdk(join(root, "jre"), { javac: false, classData: null }),
      // A jlink image with the compiler module left in has javac but no class data.
      await makeJdk(join(root, "jlink"), { classData: null }),
      await makeJdk(join(root, "no-release"), { release: false }),
      await makeJdk(join(root, "bad-version"), { version: "unknown" }),
    ];
    for (const dir of negatives) {
      const { env } = await resolveJavaEnv(wt, isolated({ overridePath: dir }));
      expect(env).toBeNull();
    }
  });

  test("a release file that is a pipe does not qualify and does not hang", async () => {
    await setup();
    const jdk = await makeJdk(join(root, "jdk"), { release: false });
    Bun.spawnSync(["mkfifo", join(jdk, "release")]);
    expect((await resolveJavaEnv(wt, isolated({ overridePath: jdk }))).env).toBeNull();
  });

  test("never runs anything from a JDK", async () => {
    await setup();
    const jdk = await makeJdk(join(root, "jdk"));
    const bin = join(root, "bin");
    await mkdir(bin);
    await symlink(javaExecutable(jdk), join(bin, "java"));
    await resolveJavaEnv(wt, isolated({ env: { PATH: bin, JAVA_HOME: jdk } }));
    await listJavaRuntimes(wt, isolated({ env: { PATH: bin, JAVA_HOME: jdk } }));
    await normalizeJavaOverride(wt, jdk);
    expect(await Bun.file(ranMarker).exists()).toBe(false);
  });

  test("parses the release file format", () => {
    const release = parseReleaseFile(
      'IMPLEMENTOR="Eclipse Adoptium"\nJAVA_VERSION="21.0.13"\r\nX=1',
    );
    expect(release.get("IMPLEMENTOR")).toBe("Eclipse Adoptium");
    expect(release.get("JAVA_VERSION")).toBe("21.0.13");
    expect(release.get("X")).toBe("1");
  });

  test("reads the Java level of every version style", () => {
    expect(javaMajorVersion("21.0.5")).toBe(21);
    expect(javaMajorVersion("22-ea")).toBe(22);
    expect(javaMajorVersion("25")).toBe(25);
    expect(javaMajorVersion("1.8.0_392")).toBe(8);
    expect(javaMajorVersion("unknown")).toBeNull();
  });
});

describe("resolution order", () => {
  test("the override, JAVA_HOME, java_home, PATH, then install locations", async () => {
    await setup();
    const [override, javaHome, fromTool, onPath, installed] = await Promise.all(
      ["override", "java-home", "tool", "on-path", "installs/one"].map((name) =>
        makeJdk(join(root, name)),
      ),
    );
    const tool = await writeExecutable(
      join(root, "java_home"),
      `#!/bin/sh\necho '    21.0.5 (arm64) "Eclipse Adoptium" - "OpenJDK 21.0.5" ${fromTool}' >&2\n`,
    );
    const bin = dirname(javaExecutable(onPath!));
    const all = {
      overridePath: override!,
      javaHomeTool: tool,
      installRoots: [{ dir: dirname(installed!) }],
      env: { PATH: bin, JAVA_HOME: javaHome },
    };
    const sourceOf = async (options: typeof all | Parameters<typeof resolveJavaEnv>[1]) => {
      const { env } = await resolveJavaEnv(wt, options);
      return [env?.source, env?.path];
    };
    expect(await sourceOf(all)).toEqual(["override", override]);
    expect(await sourceOf({ ...all, overridePath: null })).toEqual(["java-home", javaHome]);
    const noHome = { ...all, overridePath: null, env: { PATH: bin } };
    expect(await sourceOf(noHome)).toEqual(["java-home-tool", fromTool]);
    expect(await sourceOf({ ...noHome, javaHomeTool: null })).toEqual(["path", onPath]);
    expect(await sourceOf({ ...noHome, javaHomeTool: null, env: { PATH: "" } })).toEqual([
      "install-location",
      installed,
    ]);
  });

  test("a stale JAVA_HOME is ignored and reported, like /opt/homebrew/opt/openjdk here", async () => {
    await setup();
    const installed = await makeJdk(join(root, "installs", "one"));
    const stale = join(root, "opt", "openjdk");
    const { env, ignoredJavaHome } = await resolveJavaEnv(
      wt,
      isolated({
        installRoots: [{ dir: dirname(installed) }],
        env: { PATH: "", JAVA_HOME: stale },
      }),
    );
    expect(env?.source).toBe("install-location");
    expect(ignoredJavaHome).toBe(stale);
  });

  test("a JAVA_HOME that is a JRE or relative is ignored too, and a valid one is not reported", async () => {
    await setup();
    const jre = await makeJdk(join(root, "jre"), { javac: false, classData: null });
    const report = async (JAVA_HOME: string) =>
      (await resolveJavaEnv(wt, isolated({ env: { PATH: "", JAVA_HOME } }))).ignoredJavaHome;
    expect(await report(jre)).toBe(jre);
    expect(await report("relative/jdk")).toBe("relative/jdk");
    expect(await report(await makeJdk(join(root, "jdk")))).toBeNull();
  });

  test("a chosen JDK that went missing falls through to detection", async () => {
    await setup();
    const jdk = await makeJdk(join(root, "jdk"));
    const { env } = await resolveJavaEnv(
      wt,
      isolated({ overridePath: join(root, "gone"), env: { PATH: "", JAVA_HOME: jdk } }),
    );
    expect(env?.source).toBe("java-home");
  });

  test("finds nothing without throwing", async () => {
    await setup();
    expect(await resolveJavaEnv(wt, isolated())).toEqual({ env: null, ignoredJavaHome: null });
    expect(await listJavaRuntimes(wt, isolated())).toEqual([]);
  });

  test("picks the newest of several", async () => {
    await setup();
    const installs = join(root, "installs");
    await makeJdk(join(installs, "a"), { version: "17.0.13" });
    await makeJdk(join(installs, "b"), { version: "21.0.5" });
    const newest = await makeJdk(join(installs, "c"), { version: "21.0.13" });
    await makeJdk(join(installs, "d"), { version: "1.8.0_392" });
    const { env } = await resolveJavaEnv(wt, isolated({ installRoots: [{ dir: installs }] }));
    expect(env?.path).toBe(newest);
  });
});

describe("the macOS java_home tool", () => {
  test("parses its list of JDKs", () => {
    const output = [
      "Matching Java Virtual Machines (2):",
      '    21.0.5 (arm64) "Eclipse Adoptium" - "OpenJDK 21.0.5" /Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home',
      '    17.0.1 (x86_64) "A/B Corp" - "Java SE 17" /Users/me/Library/Java/JavaVirtualMachines/my jdk/Contents/Home',
      "/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home",
      "",
    ].join("\n");
    expect(parseJavaHomeList(output)).toEqual([
      "/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home",
      "/Users/me/Library/Java/JavaVirtualMachines/my jdk/Contents/Home",
    ]);
  });

  test("finds nothing in its message for no JDK, measured on macOS without Java", () => {
    const output = `The operation couldn’t be completed. Unable to locate a Java Runtime.
Please visit http://www.java.com for information on installing Java.

`;
    expect(parseJavaHomeList(output)).toEqual([]);
  });

  test("a failing or missing tool falls through", async () => {
    await setup();
    const jdk = await makeJdk(join(root, "installs", "one"));
    const roots = [{ dir: dirname(jdk) }];
    const failing = await writeExecutable(join(root, "tool"), "#!/bin/sh\necho nope >&2\nexit 1\n");
    for (const javaHomeTool of [failing, join(root, "missing-tool")]) {
      const { env } = await resolveJavaEnv(wt, isolated({ javaHomeTool, installRoots: roots }));
      expect(env?.source).toBe("install-location");
    }
  });

  test("a home it lists that is not a JDK does not count", async () => {
    await setup();
    const jre = await makeJdk(join(root, "jre"), { javac: false, classData: null });
    const javaHomeTool = await writeExecutable(
      join(root, "tool"),
      `#!/bin/sh\necho '    21 (arm64) "X" - "Y" ${jre}' >&2\n`,
    );
    expect((await resolveJavaEnv(wt, isolated({ javaHomeTool }))).env).toBeNull();
  });
});

describe("java on PATH", () => {
  test("follows symlinks to the JDK", async () => {
    await setup();
    const jdk = await makeJdk(join(root, "jdk"));
    const bin = join(root, "bin");
    await mkdir(bin);
    await symlink(javaExecutable(jdk), join(bin, "java"));
    const { env } = await resolveJavaEnv(wt, isolated({ env: { PATH: bin } }));
    expect([env?.source, env?.path]).toEqual(["path", jdk]);
  });

  test("a shim outside any JDK does not hide a real java later on PATH", async () => {
    await setup();
    const shims = join(root, "asdf", "shims");
    await writeExecutable(join(shims, "java"), `#!/bin/sh\ntouch "${ranMarker}"\n`);
    const jdk = await makeJdk(join(root, "jdk"));
    const { env } = await resolveJavaEnv(
      wt,
      isolated({ env: { PATH: `${shims}:${join(jdk, "bin")}` } }),
    );
    expect(env?.path).toBe(jdk);
    expect(await Bun.file(ranMarker).exists()).toBe(false);
  });

  test("recognizes the macOS stub by path, on macOS only", () => {
    expect(isMacOsJavaStub("/usr/bin/java", "darwin")).toBe(true);
    expect(
      isMacOsJavaStub(
        "/System/Library/Frameworks/JavaVM.framework/Versions/A/Commands/java",
        "darwin",
      ),
    ).toBe(true);
    expect(isMacOsJavaStub("/opt/homebrew/bin/java", "darwin")).toBe(false);
    expect(isMacOsJavaStub("/usr/bin/java", "linux")).toBe(false);
  });

  test.if(process.platform === "darwin")("skips /usr/bin/java", async () => {
    await setup();
    const { env } = await resolveJavaEnv(wt, isolated({ env: { PATH: "/usr/bin" } }));
    expect(env).toBeNull();
  });
});

describe("install locations", () => {
  test("finds a JDK in each well-known layout, once", async () => {
    await setup();
    const roots = javaInstallRoots({ HOME: home }, "darwin");
    const layouts = [
      "Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home",
      ".sdkman/candidates/java/21.0.5-tem",
      ".asdf/installs/java/temurin-21.0.5",
      ".local/share/mise/installs/java/21.0.5",
      ".jdks/corretto-21.0.5",
      // Gradle nests a toolchain, with a bundle on macOS.
      ".gradle/jdks/eclipse_adoptium-21-aarch64-os_x/jdk-21.0.5+11/Contents/Home",
    ].map((layout) => join(home, layout));
    await Promise.all(layouts.map((jdk) => makeJdk(jdk)));
    // sdkman's `current` is the same JDK.
    await symlink(
      join(home, ".sdkman/candidates/java/21.0.5-tem"),
      join(home, ".sdkman/candidates/java/current"),
    );
    // Beside Gradle's toolchains: a lock file and an unfinished download.
    await writeFile(join(home, ".gradle/jdks/some.lock"), "");
    await mkdir(join(home, ".gradle/jdks/partial/jdk-17"), { recursive: true });

    const found = await listJavaRuntimes(wt, isolated({ installRoots: roots }));
    expect(found.map((runtime) => runtime.path).toSorted()).toEqual(layouts.toSorted());
    expect(found.every((runtime) => runtime.source === "install-location")).toBe(true);
  });

  test("the roots honor the tools' own variables", () => {
    const dirs = javaInstallRoots({
      HOME: "/h",
      SDKMAN_DIR: "/s",
      ASDF_DATA_DIR: "/a",
      MISE_DATA_DIR: "/m",
      GRADLE_USER_HOME: "/g",
    }).map((root) => root.dir);
    expect(dirs).toContain("/s/candidates/java");
    expect(dirs).toContain("/a/installs/java");
    expect(dirs).toContain("/m/installs/java");
    expect(dirs).toContain("/g/jdks");
    expect(javaInstallRoots({ HOME: "/h", XDG_DATA_HOME: "/x" }).map((r) => r.dir)).toContain(
      "/x/mise/installs/java",
    );
  });

  test("the system locations are only this platform's", () => {
    const dirs = (platform: NodeJS.Platform) =>
      javaInstallRoots({ HOME: "/h" }, platform).map((root) => root.dir);
    expect(dirs("darwin")).toContain("/Library/Java/JavaVirtualMachines");
    expect(dirs("darwin")).toContain("/opt/homebrew/opt");
    expect(dirs("darwin")).not.toContain("/usr/lib/jvm");
    expect(dirs("linux")).toContain("/usr/lib/jvm");
    expect(dirs("linux")).not.toContain("/Library/Java/JavaVirtualMachines");
  });

  test("Homebrew's opt holds only its openjdk formulas, as bundles", async () => {
    await setup();
    const opt = join(root, "homebrew", "opt");
    const jdk = join(opt, "openjdk@21", "libexec", "openjdk.jdk", "Contents", "Home");
    await makeJdk(jdk);
    // Homebrew links a java into the formula's own bin, next to no release file.
    await writeExecutable(join(opt, "openjdk@21", "bin", "java"), "#!/bin/sh\n");
    await makeJdk(join(opt, "not-a-jdk-formula"));
    const found = await listJavaRuntimes(
      wt,
      isolated({ installRoots: [{ dir: opt, entryPrefix: "openjdk" }] }),
    );
    expect(found.map((runtime) => runtime.path)).toEqual([jdk]);
  });

  test("lists every JDK newest first, for one per Java level", async () => {
    await setup();
    const installs = join(root, "installs");
    const jdk11 = await makeJdk(join(installs, "a"), { version: "11.0.25" });
    const jdk25 = await makeJdk(join(installs, "b"), { version: "25.0.1" });
    const jdk17 = await makeJdk(join(installs, "c"), { version: "17.0.13" });
    const javaHome = await makeJdk(join(root, "elsewhere"), { version: "21.0.5" });
    const found = await listJavaRuntimes(
      wt,
      isolated({ installRoots: [{ dir: installs }], env: { PATH: "", JAVA_HOME: javaHome } }),
    );
    expect(found.map(({ path, majorVersion }) => ({ path, majorVersion }))).toEqual([
      { path: jdk25, majorVersion: 25 },
      { path: javaHome, majorVersion: 21 },
      { path: jdk17, majorVersion: 17 },
      { path: jdk11, majorVersion: 11 },
    ]);
  });
});

describe("the trust rule", () => {
  test("refuses a JDK in the worktree that git tracks, from every source", async () => {
    await setup();
    const jdk = await makeJdk(join(wt, "jdk"));
    git("add", "jdk");
    const options = isolated({
      overridePath: jdk,
      installRoots: [{ dir: wt }],
      env: { PATH: join(jdk, "bin"), JAVA_HOME: jdk },
    });
    const { env, ignoredJavaHome } = await resolveJavaEnv(wt, options);
    expect(env).toBeNull();
    expect(ignoredJavaHome).toBe(jdk);
    expect(await listJavaRuntimes(wt, options)).toEqual([]);
    await expect(normalizeJavaOverride(wt, jdk)).rejects.toThrow("tracks in git");
  });

  test("refuses a JDK with a single tracked file", async () => {
    await setup();
    const jdk = await makeJdk(join(wt, "jdk"));
    git("add", "jdk/lib/ct.sym");
    expect((await resolveJavaEnv(wt, isolated({ overridePath: jdk }))).env).toBeNull();
  });

  test("refuses a committed symlink, however real what it reaches is", async () => {
    await setup();
    const real = await makeJdk(join(root, "real-jdk"));
    await symlink(real, join(wt, "jdk"));
    git("add", "jdk");
    const { env } = await resolveJavaEnv(wt, isolated({ overridePath: join(wt, "jdk") }));
    expect(env).toBeNull();
  });

  test("refuses a committed symlink to a bundle, whose home lies past the link", async () => {
    await setup();
    await makeJdk(join(root, "real.jdk", "Contents", "Home"));
    await symlink(join(root, "real.jdk"), join(wt, "jdk"));
    git("add", "jdk");
    const { env } = await resolveJavaEnv(wt, isolated({ overridePath: join(wt, "jdk") }));
    expect(env).toBeNull();
    await expect(normalizeJavaOverride(wt, join(wt, "jdk"))).rejects.toThrow("tracks in git");
  });

  test("refuses a committed java on PATH that links to a real JDK", async () => {
    await setup();
    const real = await makeJdk(join(root, "real-jdk"));
    await mkdir(join(wt, "bin"));
    await symlink(javaExecutable(real), join(wt, "bin", "java"));
    git("add", "bin");
    const { env } = await resolveJavaEnv(wt, isolated({ env: { PATH: join(wt, "bin") } }));
    expect(env).toBeNull();
  });

  test("refuses a JDK whose home is the worktree or holds it", async () => {
    await setup();
    await makeJdk(wt);
    git("add", "release", "lib");
    expect((await resolveJavaEnv(wt, isolated({ overridePath: wt }))).env).toBeNull();
    const outer = await makeJdk(root);
    expect((await resolveJavaEnv(wt, isolated({ overridePath: outer }))).env).toBeNull();
  });

  test("takes an untracked JDK in the worktree, and one outside", async () => {
    await setup();
    const inside = await makeJdk(join(wt, ".jdk"));
    const { env } = await resolveJavaEnv(wt, isolated({ overridePath: inside }));
    expect(env?.path).toBe(inside);
    const outside = await makeJdk(join(root, "jdk"));
    const out = await resolveJavaEnv(wt, isolated({ overridePath: outside }));
    expect(out.env?.path).toBe(outside);
  });
});

describe("normalizeJavaOverride", () => {
  test("takes a home, a bundle, a java executable and a Homebrew directory", async () => {
    await setup();
    const jdk = await makeJdk(join(root, "jdk"));
    expect(await normalizeJavaOverride(wt, `  ${jdk}/ `)).toBe(jdk);
    expect(await normalizeJavaOverride(wt, javaExecutable(jdk))).toBe(jdk);
    const bundleHome = await makeJdk(join(root, "temurin.jdk", "Contents", "Home"));
    expect(await normalizeJavaOverride(wt, join(root, "temurin.jdk"))).toBe(bundleHome);
    const brewHome = await makeJdk(
      join(root, "opt", "openjdk", "libexec", "openjdk.jdk", "Contents", "Home"),
    );
    expect(await normalizeJavaOverride(wt, join(root, "opt", "openjdk"))).toBe(brewHome);
  });

  test("takes a directory named java, as Fedora's /usr/lib/jvm/java is", async () => {
    await setup();
    const jdk = await makeJdk(join(root, "jvm", "java"));
    expect(await normalizeJavaOverride(wt, jdk)).toBe(jdk);
  });

  test("rejects a relative path, a missing one and a JRE", async () => {
    await setup();
    const jre = await makeJdk(join(root, "jre"), { javac: false, classData: null });
    await expect(normalizeJavaOverride(wt, "jdk")).rejects.toThrow("absolute");
    await expect(normalizeJavaOverride(wt, join(root, "gone"))).rejects.toThrow("No JDK");
    await expect(normalizeJavaOverride(wt, jre)).rejects.toThrow("not of a JRE");
  });
});

describe("the shared resolution", () => {
  /** Resolves with the first update `accept` takes; a miss fails through the test's timeout. */
  function nextUpdate(
    worktree: string,
    accept: (env: JavaEnv | null, changed: boolean) => boolean,
  ): { update: Promise<JavaEnv | null>; unsubscribe: () => void } {
    let unsubscribe = () => {};
    const update = new Promise<JavaEnv | null>((resolve) => {
      unsubscribe = subscribeJavaEnv(worktree, ({ env, changed }) => {
        if (accept(env, changed)) resolve(env);
      });
    });
    return { update, unsubscribe };
  }

  test("memoizes while subscribed, and follows a changed override", async () => {
    await setup();
    const first = await makeJdk(join(root, "first"));
    const second = await makeJdk(join(root, "second"), { version: "25.0.1" });
    process.env.JAVA_HOME = first;
    const firstResolved = nextUpdate(wt, (env) => env?.path === first);
    const secondResolved = nextUpdate(wt, (env, changed) => changed && env?.path === second);
    try {
      expect((await getJavaEnv(wt))?.path).toBe(first);
      await firstResolved.update;

      setJavaOverride(wt, second);
      refreshJavaEnv(wt);
      const { source, path } = (await secondResolved.update)!;
      expect([source, path]).toEqual(["override", second]);
      expect((await getJavaEnv(wt))?.path).toBe(second);
    } finally {
      firstResolved.unsubscribe();
      secondResolved.unsubscribe();
      setJavaOverride(wt, null);
    }
  });

  test("resolves afresh without a subscriber, and revalidates a changed override", async () => {
    await setup();
    const jdk = await makeJdk(join(root, "jdk"));
    const picked = await makeJdk(join(root, "picked"));
    process.env.JAVA_HOME = jdk;
    expect((await getJavaEnv(wt))?.path).toBe(jdk);
    const unsubscribe = subscribeJavaEnv(wt, () => {});
    try {
      expect((await getJavaEnv(wt))?.path).toBe(jdk);
      // Behind the change hook, which is what server.ts subscribes refreshJavaEnv to.
      setJavaOverride(wt, picked);
      expect(getJavaOverride(wt)).toBe(picked);
      expect((await getJavaEnv(wt))?.path).toBe(picked);
    } finally {
      unsubscribe();
      setJavaOverride(wt, null);
    }
  });

  test("withdraws a JDK the repository has started tracking", async () => {
    await setup();
    const jdk = await makeJdk(join(wt, ".jdk"));
    process.env.JAVA_HOME = jdk;
    const unsubscribe = subscribeJavaEnv(wt, () => {});
    try {
      expect((await getJavaEnv(wt))?.path).toBe(jdk);
      git("add", ".jdk");
      const { ignoredJavaHome } = await getJavaEnvResolution(wt);
      expect(ignoredJavaHome).toBe(jdk);
    } finally {
      unsubscribe();
    }
  });

  test("login-shell changes re-resolve only when they touch what resolution reads", async () => {
    await setup();
    const before = await makeJdk(join(root, "before"));
    const after = await makeJdk(join(root, "after"), { version: "25.0.1" });
    process.env.JAVA_HOME = before;
    const unsubscribe = subscribeJavaEnv(wt, () => {});
    try {
      expect((await getJavaEnv(wt))?.path).toBe(before);
      process.env.JAVA_HOME = after;
      refreshAllJavaEnvs(["SSH_AUTH_SOCK", "TERM_SESSION_ID"]);
      expect((await getJavaEnv(wt))?.path).toBe(before);
      refreshAllJavaEnvs(["JAVA_HOME"]);
      expect((await getJavaEnv(wt))?.path).toBe(after);
    } finally {
      unsubscribe();
    }
  });

  test("notices the JDK at JAVA_HOME appearing and disappearing", async () => {
    await setup();
    const jdk = join(root, "appears", "jdk");
    const staging = await makeJdk(join(root, "staging"));
    process.env.JAVA_HOME = jdk;
    const appeared = nextUpdate(wt, (env) => env?.path === jdk);
    try {
      expect((await getJavaEnvResolution(wt)).ignoredJavaHome).toBe(jdk);
      await mkdir(dirname(jdk));
      await rename(staging, jdk);
      const env = await repeatUntil(appeared.update, async () => {
        await rename(jdk, staging);
        await rename(staging, jdk);
      });
      expect(env?.source).toBe("java-home");

      const disappeared = nextUpdate(wt, (env) => env?.path !== jdk);
      try {
        await rename(jdk, staging);
        await repeatUntil(disappeared.update, async () => {
          await mkdir(jdk);
          await rm(jdk, { recursive: true });
        });
      } finally {
        disappeared.unsubscribe();
      }
    } finally {
      appeared.unsubscribe();
    }
  }, 60_000);
});

describe("watching", () => {
  /** Resolves once `watch` reported a change, repeating `poke` until it has noticed one. */
  async function reportedChange(
    targets: ReturnType<typeof javaWatchTargets>,
    poke: () => Promise<void>,
  ): Promise<void> {
    let changed = () => {};
    const reported = new Promise<void>((resolve) => {
      changed = resolve;
    });
    const watch = watchJavaEnv(targets, changed);
    try {
      // A platform watch may start a moment after it is created and miss what happens before.
      while (!watch.hasPendingChange) {
        await poke();
        await Bun.sleep(50);
      }
      await reported;
    } finally {
      watch.close();
    }
  }

  test("watches a missing root's deepest existing ancestor for the next segment", async () => {
    await setup();
    const dir = join(home, ".sdkman", "candidates", "java");
    const targets = javaWatchTargets([{ dir }], []);
    expect([...targets]).toEqual([[home, new Set([".sdkman"])]]);
  });

  test("watches an existing root whole, and only unfinished entries of it", async () => {
    await setup();
    const installs = join(root, "installs");
    await makeJdk(join(installs, "complete"));
    const partial = join(installs, "partial");
    await mkdir(partial, { recursive: true });
    const targets = javaWatchTargets([{ dir: installs }], []);
    expect([...targets.keys()].toSorted()).toEqual([installs, partial].toSorted());
    expect(targets.get(installs)).toBeNull();
  });

  test("keeps watching an entry until it has everything a JDK needs, in bin and lib too", async () => {
    await setup();
    const installs = join(root, "installs");
    const entry = await makeJdk(join(installs, "installing"), { classData: null });
    const targets = javaWatchTargets([{ dir: installs }], []);
    expect(targets.get(entry)).toBeNull();
    expect(targets.get(join(entry, "bin"))).toBeNull();
    expect(targets.get(join(entry, "lib"))).toBeNull();
  });

  test("does not watch a filesystem root for what is missing below it", () => {
    expect([...javaWatchTargets([{ dir: "/no-such-java-dir/jvm" }], []).keys()]).toEqual([]);
  });

  test("watches a home for being removed, replaced, or created", async () => {
    await setup();
    const jdk = await makeJdk(join(root, "jdk"));
    const missing = join(root, "not-yet", "jdk");
    const targets = javaWatchTargets([], [jdk, missing, "relative/ignored"]);
    expect(targets.get(root)).toEqual(new Set(["jdk", "not-yet"]));
    expect(targets.get(jdk)).toEqual(new Set(["release", "bin"]));
  });

  test("reports a JDK directory appearing in a root", async () => {
    await setup();
    const installs = join(root, "installs");
    await mkdir(installs);
    let count = 0;
    await reportedChange(javaWatchTargets([{ dir: installs }], []), () =>
      mkdir(join(installs, `new-jdk-${count++}`)).then(() => {}),
    );
  }, 60_000);

  test("reports an installer filling an entry that was incomplete", async () => {
    await setup();
    const entry = join(root, "installs", "installing");
    await mkdir(entry, { recursive: true });
    await reportedChange(javaWatchTargets([{ dir: join(root, "installs") }], []), () =>
      writeFile(join(entry, "release"), 'JAVA_VERSION="21"\n'),
    );
  }, 60_000);
});
