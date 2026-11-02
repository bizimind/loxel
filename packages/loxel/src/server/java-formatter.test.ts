import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { DEFAULT_FORMATTING_SETTINGS } from "@/lib/formatting-model";

// Reaches the JDK override; keep it out of the real store.
const stateDir = await mkdtemp(join(tmpdir(), "java-formatter-state-"));
process.env.LOXEL_STATE_DIR = stateDir;
const { FormatService } = await import("./format-service");

const originalEnv = { ...process.env };
let root: string | undefined;
const service = new FormatService();

afterEach(async () => {
  process.env.PATH = originalEnv.PATH;
  process.env.HOME = originalEnv.HOME;
  delete process.env.JAVA_HOME;
  delete process.env.GRADLE_USER_HOME;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

afterAll(async () => {
  service.destroy();
  await rm(stateDir, { recursive: true, force: true });
});

async function write(path: string, content: string, mode?: number): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  if (mode) await chmod(path, mode);
  return path;
}

async function makeWorktree(files: Record<string, string>): Promise<string> {
  root = await realpath(await mkdtemp(join(tmpdir(), "java-formatter-")));
  const wt = join(root, "wt");
  await mkdir(wt);
  for (const [name, content] of Object.entries(files)) await write(join(wt, name), content);
  // A home of the test's own, so the real Maven and Gradle caches stay out of it.
  process.env.HOME = join(root, "home");
  await mkdir(process.env.HOME);
  return wt;
}

/**
 * A tool in the machine's own directory, first on `PATH`: it reports `version` and records how it
 * was started, then answers a format with what `--version` would not.
 */
async function installTool(name: string, version: string, dir = "bin"): Promise<string> {
  const bin = join(root ?? "", dir);
  const script = `#!/bin/sh
if [ "$1" = "--version" ]; then
  pwd > "${bin}/version-cwd"
  echo "${name}: Version ${version}" >&2
  exit 0
fi
pwd > "${bin}/format-cwd"
echo "$@" > "${bin}/format-args"
cat > /dev/null
echo "formatted by ${name} ${version}"
`;
  await write(join(bin, name), script, 0o755);
  process.env.PATH = `${bin}:${originalEnv.PATH}`;
  return bin;
}

const GOOGLE = "google-java-format";
const PALANTIR = "palantir-java-format";
const gjfPom = (version?: string) => `<project><build><plugins><plugin>
  <artifactId>spotless-maven-plugin</artifactId>
  <configuration><java><googleJavaFormat>${version ? `<version>${version}</version>` : ""}</googleJavaFormat></java></configuration>
</plugin></plugins></build></project>`;

function format(wt: string, file = "src/main/java/A.java") {
  return service.format("class A{}", join(wt, file), wt, DEFAULT_FORMATTING_SETTINGS);
}

describe("choosing what runs", () => {
  test("a project with no signal is not formatted", async () => {
    const wt = await makeWorktree({ "pom.xml": "<project/>" });
    const bin = await installTool(GOOGLE, "1.22.0");
    expect(await format(wt)).toEqual({ content: null });
    expect(await readdir(bin)).toEqual([GOOGLE]);
  });

  test("the pinned version runs, from the filesystem root", async () => {
    const wt = await makeWorktree({ "pom.xml": gjfPom("1.22.0") });
    const bin = await installTool(GOOGLE, "1.22.0");
    expect(await format(wt)).toEqual({ content: `formatted by ${GOOGLE} 1.22.0\n` });
    expect(await Bun.file(join(bin, "version-cwd")).text()).toBe("/\n");
    expect(await Bun.file(join(bin, "format-cwd")).text()).toBe("/\n");
    expect(await Bun.file(join(bin, "format-args")).text()).toBe(
      `--skip-reflowing-long-strings --assume-filename=${join(wt, "src/main/java/A.java")} -\n`,
    );
  });

  test("another version declines, naming both", async () => {
    const wt = await makeWorktree({ "pom.xml": gjfPom("1.22.0") });
    const bin = await installTool(GOOGLE, "1.37.0");
    const { content, notice } = await format(wt);
    expect(content).toBeNull();
    expect(notice).toContain(`pins ${GOOGLE} 1.22.0`);
    expect(notice).toContain("is 1.37.0");
    expect(await Bun.file(join(bin, "format-args")).exists()).toBe(false);
  });

  test("a later copy on PATH at the pinned version is used", async () => {
    const wt = await makeWorktree({ "pom.xml": gjfPom("1.22.0") });
    const pinned = await installTool(GOOGLE, "1.22.0", "pinned");
    await installTool(GOOGLE, "1.37.0", "newer");
    process.env.PATH = `${join(root ?? "", "newer")}:${pinned}:${originalEnv.PATH}`;
    expect(await format(wt)).toEqual({ content: `formatted by ${GOOGLE} 1.22.0\n` });
  });

  test("Spotless with no version declines before asking any tool", async () => {
    const wt = await makeWorktree({
      "pom.xml": gjfPom().replace("<googleJavaFormat></googleJavaFormat>", "<googleJavaFormat/>"),
    });
    const bin = await installTool(GOOGLE, "1.37.0");
    expect((await format(wt)).notice).toContain("Spotless chooses");
    expect(await readdir(bin)).toEqual([GOOGLE]);
  });

  test("the fmt plugin's version of the formatter comes from its POM in the cache", async () => {
    const pom = `<project><build><plugins><plugin>
      <groupId>com.spotify.fmt</groupId><artifactId>fmt-maven-plugin</artifactId><version>2.29</version>
    </plugin></plugins></build></project>`;
    const wt = await makeWorktree({ "pom.xml": pom });
    await installTool(GOOGLE, "1.37.0");
    expect((await format(wt)).notice).toContain("can't determine");
    await write(
      join(
        process.env.HOME ?? "",
        ".m2/repository/com/spotify/fmt/fmt-maven-plugin/2.29/fmt-maven-plugin-2.29.pom",
      ),
      `<project><dependency><artifactId>google-java-format</artifactId><version>1.28.0</version></dependency></project>`,
    );
    expect((await format(wt)).notice).toContain(
      `pins ${GOOGLE} 1.28.0, and the one on your PATH is 1.37.0`,
    );
  });

  test("a file the project's target leaves out is saved as it is, silently", async () => {
    const wt = await makeWorktree({
      "build.gradle":
        "spotless { java { googleJavaFormat('1.22.0')\n targetExclude '**/generated/**' } }\n",
    });
    const bin = await installTool(GOOGLE, "1.22.0");
    expect(await format(wt, "src/generated/A.java")).toEqual({ content: null });
    expect(await readdir(bin)).toEqual([GOOGLE]);
    expect((await format(wt, "src/main/java/A.java")).content).toContain("formatted by");
  });

  test("hanging launchers cost one deadline, whatever their number", async () => {
    const wt = await makeWorktree({ "pom.xml": gjfPom("1.22.0") });
    const hanging = "#!/bin/sh\nsleep 30 &\nwait\n";
    const first = await write(join(root ?? "", "a", GOOGLE), hanging, 0o755);
    const second = await write(join(root ?? "", "b", GOOGLE), hanging, 0o755);
    process.env.PATH = `${dirname(first)}:${dirname(second)}:/usr/bin:/bin`;
    const short = new FormatService(undefined, 20);
    const { content, notice } = await short.format(
      "class A{}",
      join(wt, "src/main/java/A.java"),
      wt,
      DEFAULT_FORMATTING_SETTINGS,
    );
    short.destroy();
    expect(content).toBeNull();
    expect(notice).toContain("took too long");
  });

  test("a missing tool says what to install", async () => {
    const wt = await makeWorktree({ "pom.xml": gjfPom("1.22.0") });
    process.env.PATH = "/usr/bin:/bin";
    const { notice } = await format(wt);
    expect(notice).toContain(`${GOOGLE} 1.22.0, which is not on your PATH`);
    expect(notice).toContain("GitHub releases");
  });

  test("a JVM's error is no version, and is asked again once fixed", async () => {
    const wt = await makeWorktree({ "pom.xml": gjfPom("1.22.0") });
    const bin = await installTool(GOOGLE, "1.22.0");
    const failing =
      '#!/bin/sh\necho "Error: compiled by a more recent version of the Java Runtime" >&2\nexit 1\n';
    await write(join(bin, GOOGLE), failing, 0o755);
    const { notice } = await format(wt);
    expect(notice).toContain("not on your PATH");
    expect(notice).not.toContain(" is of");
    await installTool(GOOGLE, "1.22.0");
    expect((await format(wt)).content).toBe(`formatted by ${GOOGLE} 1.22.0\n`);
  });

  test("palantir needs its own flag, and has no cache route", async () => {
    const wt = await makeWorktree({
      "build.gradle": "spotless { java { palantirJavaFormat('2.103.0') } }\n",
    });
    const bin = await installTool(PALANTIR, "2.103.0");
    expect(await format(wt)).toEqual({ content: `formatted by ${PALANTIR} 2.103.0\n` });
    expect(await Bun.file(join(bin, "format-args")).text()).toStartWith(
      "--palantir --skip-reflowing-long-strings --assume-filename=",
    );
    process.env.PATH = "/usr/bin:/bin";
    expect((await format(wt)).notice).toContain(`${PALANTIR} 2.103.0, which is not on your PATH`);
  });

  test("a changed tool is asked its version again", async () => {
    const wt = await makeWorktree({ "pom.xml": gjfPom("1.22.0") });
    await installTool(GOOGLE, "1.37.0.1");
    expect((await format(wt)).notice).toContain("is 1.37.0.1");
    await installTool(GOOGLE, "1.22.0");
    expect((await format(wt)).content).toBe(`formatted by ${GOOGLE} 1.22.0\n`);
  });

  test("a manual override runs whatever the version", async () => {
    const wt = await makeWorktree({ "pom.xml": gjfPom("1.22.0") });
    await installTool(GOOGLE, "1.37.0");
    const result = await service.format("class A{}", join(wt, "src/main/java/A.java"), wt, {
      ...DEFAULT_FORMATTING_SETTINGS,
      overrides: [{ id: "java", extensions: "java", command: GOOGLE, args: "-" }],
    });
    expect(result).toEqual({ content: `formatted by ${GOOGLE} 1.37.0\n` });
  });

  test("Settings lists a declared formatter without running anything", async () => {
    const wt = await makeWorktree({ "pom.xml": gjfPom("1.22.0") });
    const bin = await installTool(GOOGLE, "1.37.0");
    expect(service.getDetectedFormatters(wt)).toContainEqual({
      command: GOOGLE,
      extensions: ["java"],
    });
    expect(await readdir(bin)).toEqual([GOOGLE]);
  });
});

describe("what the worktree cannot make run", () => {
  test("a fake tool in the worktree and a build file with side effects stay idle", async () => {
    const wt = await makeWorktree({ "pom.xml": gjfPom("1.22.0") });
    const canary = join(root ?? "", "canary");
    const fake = `#!/bin/sh\ntouch "${canary}"\necho fake\n`;
    await write(join(wt, "tools", GOOGLE), fake, 0o755);
    await write(join(wt, "gradlew"), fake, 0o755);
    await write(join(wt, "mvnw"), fake, 0o755);
    await write(join(wt, ".mvn/jvm.config"), `-Dcanary=${canary}\n`);
    await write(join(wt, "build.gradle"), `new File("${canary}").text = "ran"\n`);
    process.env.PATH = `${join(wt, "tools")}:./tools:/usr/bin:/bin`;
    expect((await format(wt)).notice).toContain("not on your PATH");
    expect(await Bun.file(canary).exists()).toBe(false);
  });

  test("a PATH entry leading into the worktree supplies nothing", async () => {
    const wt = await makeWorktree({ "pom.xml": gjfPom("1.22.0") });
    const canary = join(root ?? "", "canary");
    await write(join(wt, "tools", GOOGLE), `#!/bin/sh\ntouch "${canary}"\n`, 0o755);
    await symlink(join(wt, "tools"), join(root ?? "", "link"));
    process.env.PATH = `${join(root ?? "", "link")}:/usr/bin:/bin`;
    expect((await format(wt)).notice).toContain("not on your PATH");
    expect(await Bun.file(canary).exists()).toBe(false);
  });

  test("a version manager's shim is refused, by directory or by link", async () => {
    const wt = await makeWorktree({ "pom.xml": gjfPom("1.22.0") });
    const canary = join(root ?? "", "canary");
    const shims = join(root ?? "", "shims");
    await write(join(shims, GOOGLE), `#!/bin/sh\ntouch "${canary}"\n`, 0o755);
    process.env.PATH = `${shims}:/usr/bin:/bin`;
    expect((await format(wt)).notice).toContain("version manager's shim");
    const mise = await write(join(root ?? "", "mise-install", "mise"), "#!/bin/sh\n", 0o755);
    const linkDir = join(root ?? "", "linked");
    await mkdir(linkDir);
    await symlink(mise, join(linkDir, GOOGLE));
    process.env.PATH = `${linkDir}:/usr/bin:/bin`;
    expect((await format(wt)).notice).toContain("version manager's shim");
    expect(await Bun.file(canary).exists()).toBe(false);
  });

  test("a launcher script that is no shim still runs", async () => {
    const wt = await makeWorktree({ "pom.xml": gjfPom("1.22.0") });
    await installTool(GOOGLE, "1.22.0");
    expect((await format(wt)).content).toBe(`formatted by ${GOOGLE} 1.22.0\n`);
  });
});

describe("the pinned jar from the build's cache", () => {
  /** A fake JDK whose `java` formats only when `runs`, recording its arguments. */
  async function installJdk(name: string, runs: boolean): Promise<string> {
    const home = join(root ?? "", name);
    await write(join(home, "release"), `JAVA_VERSION="21.0.5"\nIMPLEMENTOR="Test"\n`);
    await write(join(home, "lib", "ct.sym"), "");
    const body = runs
      ? `echo "$@" > "${home}/args"\ncat\necho "// formatted on ${name}"\nexit 0`
      : `cat > /dev/null\nexit 1`;
    for (const tool of ["java", "javac"]) {
      await write(join(home, "bin", tool), `#!/bin/sh\n${body}\n`, 0o755);
    }
    return home;
  }

  async function cacheJar(base: string, group: string, artifact: string, version: string) {
    return write(
      join(base, ...group.split("."), artifact, version, `${artifact}-${version}.jar`),
      "",
    );
  }

  async function cacheFormatterInMaven(version: string) {
    const repo = join(process.env.HOME ?? "", ".m2", "repository");
    const jar = await cacheJar(repo, "com.google.googlejavaformat", GOOGLE, version);
    const guava = await cacheJar(repo, "com.google.guava", "guava", "33.6.0-jre");
    await cacheJar(repo, "com.google.guava", "guava", "33.9.0-android");
    await cacheJar(repo, "com.google.guava", "guava", "9.0-jre");
    const access = await cacheJar(repo, "com.google.guava", "failureaccess", "1.0.3");
    return { jar, guava, access };
  }

  test("from Maven's cache, when PATH has another version", async () => {
    const wt = await makeWorktree({ "pom.xml": gjfPom("1.22.0") });
    await installTool(GOOGLE, "1.37.0");
    const home = await installJdk("jdk", true);
    process.env.JAVA_HOME = home;
    const { jar, guava, access } = await cacheFormatterInMaven("1.22.0");
    const { content } = await format(wt);
    expect(content).toBe("class A{}// formatted on jdk\n");
    const args = await Bun.file(join(home, "args")).text();
    expect(args).toContain(`-cp ${jar}:${guava}:${access} `);
    expect(args).toContain("--add-exports=jdk.compiler/com.sun.tools.javac.tree=ALL-UNNAMED");
    expect(args).toContain("com.google.googlejavaformat.java.Main --skip-reflowing-long-strings");
    expect(args).toContain(`--assume-filename=${join(wt, "src/main/java/A.java")} -`);
  });

  test("from Gradle's cache, under GRADLE_USER_HOME", async () => {
    const wt = await makeWorktree({ "pom.xml": gjfPom("1.23.0") });
    process.env.PATH = "/usr/bin:/bin";
    const home = await installJdk("jdk", true);
    process.env.JAVA_HOME = home;
    process.env.GRADLE_USER_HOME = join(root ?? "", "gh");
    const modules = join(root ?? "", "gh", "caches", "modules-2", "files-2.1");
    const jar = await write(
      join(modules, "com.google.googlejavaformat", GOOGLE, "1.23.0", "abc", `${GOOGLE}-1.23.0.jar`),
      "",
    );
    expect((await format(wt)).content).toContain("formatted on jdk");
    expect(await Bun.file(join(home, "args")).text()).toContain(`-cp ${jar} `);
  });

  test("a version no JDK runs declines", async () => {
    const wt = await makeWorktree({ "pom.xml": gjfPom("1.37.0") });
    process.env.PATH = "/usr/bin:/bin";
    process.env.JAVA_HOME = await installJdk("jdk", false);
    await cacheFormatterInMaven("1.37.0");
    const { content, notice } = await format(wt);
    expect(content).toBeNull();
    expect(notice).toContain("doesn't run on any JDK");
  });

  test("a manual override with an absolute java keeps the worktree as its directory", async () => {
    const wt = await makeWorktree({ "pom.xml": gjfPom("1.22.0") });
    const java = await write(join(root ?? "", "own", "java"), "#!/bin/sh\npwd\n", 0o755);
    const { content } = await service.format("class A{}", join(wt, "src/main/java/A.java"), wt, {
      ...DEFAULT_FORMATTING_SETTINGS,
      overrides: [{ id: "java", extensions: "java", command: java, args: "-jar tool.jar" }],
    });
    expect(content).toBe(`${wt}\n`);
  });

  test("a cache inside the worktree is not used", async () => {
    const wt = await makeWorktree({ "pom.xml": gjfPom("1.22.0") });
    process.env.PATH = "/usr/bin:/bin";
    const home = await installJdk("jdk", true);
    process.env.JAVA_HOME = home;
    process.env.HOME = wt;
    await cacheFormatterInMaven("1.22.0");
    expect((await format(wt)).notice).toContain(`${GOOGLE} 1.22.0, which is not on your PATH`);
    expect(await Bun.file(join(home, "args")).exists()).toBe(false);
  });

  test("after no JDK ran the jar, a newly offered one is tried", async () => {
    const wt = await makeWorktree({ "pom.xml": gjfPom("1.22.0") });
    process.env.PATH = "/usr/bin:/bin";
    process.env.JAVA_HOME = await installJdk("jdk", false);
    await cacheFormatterInMaven("1.22.0");
    expect((await format(wt)).notice).toContain("doesn't run on any JDK");
    const other = await installJdk("jdk-new", true);
    process.env.JAVA_HOME = other;
    expect((await format(wt)).content).toContain("formatted on jdk-new");
  });

  test("a project's pin selects only a cached version, not a path", async () => {
    const wt = await makeWorktree({ "pom.xml": gjfPom("../../../evil") });
    expect((await format(wt)).notice).toContain("can't determine");
  });

  test("without the jar, the notice names the version", async () => {
    const wt = await makeWorktree({ "pom.xml": gjfPom("1.22.0") });
    process.env.PATH = "/usr/bin:/bin";
    process.env.JAVA_HOME = await installJdk("jdk", true);
    expect((await format(wt)).notice).toContain(`${GOOGLE} 1.22.0`);
  });
});
