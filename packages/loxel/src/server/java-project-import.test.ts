import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  applyImportSignal,
  findBuildProjects,
  getJavaProjectIssue,
  gradleClientFlags,
  importJavaToolOptions,
  importSignal,
  type ImportState,
  isProjectFile,
  localGradleHome,
  mayCarryImportSignal,
  onJavaProjectIssueChange,
  planImport,
  projectIssue,
  registeredDaemons,
  setJavaProjectIssue,
  stopGradleDaemons,
  trustedImportSettings,
  wrapperDistribution,
} from "./java-project-import";

const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "java-import-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let nextDir = 0;
function dir(files: Record<string, string> = {}): string {
  const root = path.join(scratch, `d${nextDir++}`);
  mkdirSync(root);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
  return root;
}

const NINE_EIGHT_URL = "https\\://services.gradle.org/distributions/gradle-9.8.2-bin.zip";
const wrapper = (url = NINE_EIGHT_URL) => ({
  "gradle/wrapper/gradle-wrapper.properties": `distributionBase=GRADLE_USER_HOME\ndistributionPath=wrapper/dists\ndistributionUrl=${url}\n`,
});
/** Where the real wrapper installed that distribution, under the hash it computes. */
const NINE_EIGHT_MARKER =
  "wrapper/dists/gradle-9.8.2-bin/8wepis63pzuhrlfaiy04bagwu/gradle-9.8.2-bin.zip.ok";

describe("findBuildProjects", () => {
  test("finds Maven and the topmost Gradle roots, not what a Gradle root contains", async () => {
    const root = dir({
      "svc-m/pom.xml": "",
      "svc-g/settings.gradle.kts": "",
      "svc-g/app/build.gradle.kts": "",
      "tools/Tool.java": "",
    });
    const found = await findBuildProjects(root);
    expect(found.hasMaven).toBe(true);
    expect(found.gradleRoots).toEqual([path.join(root, "svc-g")]);
    expect(found.dirs.toSorted()).toEqual(
      ["svc-g", "svc-g/app", "svc-m"].map((d) => path.join(root, d)),
    );
  });

  test("skips output, dependency and hidden folders", async () => {
    const root = dir({
      "target/pom.xml": "",
      "build/build.gradle": "",
      "node_modules/x/pom.xml": "",
      ".hidden/pom.xml": "",
    });
    expect(await findBuildProjects(root)).toEqual({ dirs: [], hasMaven: false, gradleRoots: [] });
  });
});

describe("isProjectFile", () => {
  test("knows the build files and the wrapper's properties", () => {
    for (const file of [
      "/w/pom.xml",
      "/w/a/build.gradle.kts",
      "/w/settings.gradle",
      "/w/gradle/wrapper/gradle-wrapper.properties",
    ]) {
      expect(isProjectFile(file)).toBe(true);
    }
    expect(isProjectFile("/w/src/App.java")).toBe(false);
    expect(isProjectFile("/w/pom.xml.bak")).toBe(false);
  });
});

describe("wrapperDistribution", () => {
  test("finds the distribution the wrapper would install, under its own hash", () => {
    const gradleHome = dir({ [NINE_EIGHT_MARKER]: "" });
    expect(wrapperDistribution(dir(wrapper()), { GRADLE_USER_HOME: gradleHome })).toEqual({
      name: "gradle-9.8.2-bin",
      installed: true,
    });
  });

  test("a distribution of the same name from another URL does not count", () => {
    const gradleHome = dir({ [NINE_EIGHT_MARKER]: "" });
    const other = wrapper("https\\://example.invalid/gradle-9.8.2-bin.zip");
    expect(wrapperDistribution(dir(other), { GRADLE_USER_HOME: gradleHome })?.installed).toBe(
      false,
    );
  });

  test("a directory without the wrapper's marker is not installed", () => {
    const gradleHome = dir({ "wrapper/dists/gradle-9.8.2-bin/x/partial.zip.part": "" });
    expect(wrapperDistribution(dir(wrapper()), { GRADLE_USER_HOME: gradleHome })?.installed).toBe(
      false,
    );
  });

  test("defaults to the Gradle home under HOME", () => {
    const home = dir({ [`.gradle/${NINE_EIGHT_MARKER}`]: "" });
    expect(wrapperDistribution(dir(wrapper()), { HOME: home })?.installed).toBe(true);
  });

  test("hashes the URL without its credentials, as the wrapper does", () => {
    const gradleHome = dir({ [NINE_EIGHT_MARKER]: "" });
    const url = "https\\://me:secret@services.gradle.org/distributions/gradle-9.8.2-bin.zip";
    expect(
      wrapperDistribution(dir(wrapper(url)), { GRADLE_USER_HOME: gradleHome })?.installed,
    ).toBe(true);
  });

  test("looks where the archive goes, which has its own settings", () => {
    const gradleHome = dir({ [NINE_EIGHT_MARKER.replace("wrapper/dists", "custom/zips")]: "" });
    const root = dir({
      "gradle/wrapper/gradle-wrapper.properties": `distributionPath=other\nzipStorePath=custom/zips\ndistributionUrl=${NINE_EIGHT_URL}\n`,
    });
    expect(wrapperDistribution(root, { GRADLE_USER_HOME: gradleHome })?.installed).toBe(true);
  });

  test("an empty setting doesn't take the next line's value", () => {
    const root = dir({
      "gradle/wrapper/gradle-wrapper.properties": `zipStorePath=\ndistributionUrl=${NINE_EIGHT_URL}\n`,
    });
    expect(
      wrapperDistribution(root, { GRADLE_USER_HOME: dir({ [NINE_EIGHT_MARKER]: "" }) })?.installed,
    ).toBe(true);
  });

  test("has no answer without a wrapper", () => {
    expect(wrapperDistribution(dir(), {})).toBeNull();
  });

  test("a wrapper naming no URL has nothing installed", () => {
    const root = dir({ "gradle/wrapper/gradle-wrapper.properties": "distributionBase=PROJECT\n" });
    expect(wrapperDistribution(root, {})?.installed).toBe(false);
  });
});

describe("localGradleHome", () => {
  const installation = () => dir({ "lib/gradle-launcher-9.8.2.jar": "", "bin/gradle": "" });

  test("takes GRADLE_HOME when it is an installation", () => {
    const home = installation();
    expect(localGradleHome(dir(), { GRADLE_HOME: home })).toBe(home);
    expect(localGradleHome(dir(), { GRADLE_HOME: dir() })).toBeNull();
  });

  test("follows gradle on PATH to its installation", () => {
    const home = installation();
    const bin = dir();
    symlinkSync(path.join(home, "bin/gradle"), path.join(bin, "gradle"));
    expect(localGradleHome(dir(), { PATH: bin })).toBe(home);
  });

  test("finds Homebrew's layout, with the installation under libexec", () => {
    const cellar = dir({ "libexec/lib/gradle-launcher-9.8.2.jar": "", "bin/gradle": "" });
    const bin = dir();
    symlinkSync(path.join(cellar, "bin/gradle"), path.join(bin, "gradle"));
    expect(localGradleHome(dir(), { PATH: bin })).toBe(path.join(cellar, "libexec"));
  });

  test("a shim with no installation behind it is not one", () => {
    const shims = dir({ gradle: "#!/bin/sh\n" });
    chmodSync(path.join(shims, "gradle"), 0o755);
    expect(localGradleHome(dir(), { PATH: shims })).toBeNull();
  });

  test("refuses an installation inside the worktree", () => {
    const wt = dir({ "tools/gradle/lib/gradle-launcher-1.jar": "", "tools/gradle/bin/gradle": "" });
    expect(localGradleHome(wt, { GRADLE_HOME: path.join(wt, "tools/gradle") })).toBeNull();
    expect(localGradleHome(wt, { PATH: path.join(wt, "tools/gradle/bin") })).toBeNull();
  });
});

describe("planImport", () => {
  const projects = (gradleRoots: string[], hasMaven = false) => ({
    dirs: gradleRoots,
    hasMaven,
    gradleRoots,
  });

  test("holds back a project whose wrapper has nothing installed, saying what to run", () => {
    const wt = dir(wrapper());
    const { blocked } = planImport(wt, projects([wt]), { GRADLE_USER_HOME: dir() });
    expect(blocked).toEqual([
      { root: wt, message: "gradle-9.8.2-bin isn't installed. Run ./gradlew once in a terminal." },
    ]);
  });

  test("names the folder of a project below the worktree", () => {
    const wt = dir({
      ...Object.fromEntries(Object.entries(wrapper()).map(([f, c]) => [`svc/${f}`, c])),
    });
    const { blocked } = planImport(wt, projects([path.join(wt, "svc")]), {
      GRADLE_USER_HOME: dir(),
    });
    expect(blocked[0]?.message).toContain("once in svc in a terminal");
  });

  test("loads a project whose wrapper has its distribution", () => {
    const wt = dir(wrapper());
    const env = { GRADLE_USER_HOME: dir({ [NINE_EIGHT_MARKER]: "" }) };
    expect(planImport(wt, projects([wt]), env).blocked).toEqual([]);
  });

  test("says how to fetch dependencies for the Gradle that can run", () => {
    const home = dir({ "lib/gradle-launcher-1.jar": "" });
    const wt = dir({ "svc/build.gradle": "" });
    const svc = path.join(wt, "svc");
    expect(planImport(wt, projects([svc]), { GRADLE_HOME: home }).gradleCommand).toBe(
      "gradle testClasses in svc",
    );
    const wrapped = dir(wrapper());
    const env = { GRADLE_USER_HOME: dir({ [NINE_EIGHT_MARKER]: "" }) };
    expect(planImport(wrapped, projects([wrapped]), env).gradleCommand).toBe(
      "./gradlew testClasses",
    );
    expect(planImport(wrapped, projects([wrapped]), {}).gradleCommand).toBeNull();
  });

  test("a project without a wrapper needs the user's Gradle", () => {
    const wt = dir();
    expect(planImport(wt, projects([wt]), {}).blocked[0]?.message).toContain("Install Gradle");
    const home = dir({ "lib/gradle-launcher-1.jar": "" });
    const plan = planImport(wt, projects([wt]), { GRADLE_HOME: home });
    expect(plan.blocked).toEqual([]);
    expect(plan.gradleHome).toBe(home);
  });
});

describe("trustedImportSettings", () => {
  const empty = { dirs: [], hasMaven: false, gradleRoots: [] };
  const plan = { projects: empty, blocked: [], gradleHome: null, gradleCommand: null };
  const runtimes = [{ path: "/jdk21", default: true as const }, { path: "/jdk17" }];

  test("turns import on, with everything that fetches off", () => {
    expect(trustedImportSettings("/wt", plan, runtimes)).toMatchObject({
      import: {
        maven: { enabled: true, offline: { enabled: true } },
        gradle: { enabled: true, offline: { enabled: true }, java: { home: "/jdk21" } },
      },
      autobuild: { enabled: true },
      maven: { downloadSources: false, updateSnapshots: false },
      eclipse: { downloadSources: false },
      configuration: { updateBuildConfiguration: "automatic" },
    });
  });

  test("gives Gradle's toolchains the JDKs and no way to download one", () => {
    const { import: settings } = trustedImportSettings("/wt", plan, runtimes) as {
      import: { gradle: { arguments: string[] } };
    };
    expect(settings.gradle.arguments).toEqual([
      "-Porg.gradle.java.installations.paths=/jdk21,/jdk17",
      "-Porg.gradle.java.installations.auto-download=false",
    ]);
  });

  test("excludes a blocked project, keeping the default exclusions", () => {
    const blocked = [{ root: "/wt/a[1]", message: "" }];
    const settings = trustedImportSettings("/wt", { ...plan, blocked }, runtimes);
    expect(settings).toMatchObject({ import: { gradle: { enabled: true } } });
    const { exclusions } = (settings as { import: { exclusions: string[] } }).import;
    expect(exclusions).toContain("**/node_modules/**");
    expect(exclusions).toContain("/wt/a\\[1\\]");
    expect(exclusions).toContain("/wt/a\\[1\\]/**");
    expect(exclusions).not.toContain("**");
  });

  test("turns Gradle off when the blocked project is the worktree itself", () => {
    const blocked = [{ root: "/wt", message: "" }];
    expect(trustedImportSettings("/wt", { ...plan, blocked }, runtimes)).toMatchObject({
      import: { gradle: { enabled: false } },
    });
  });

  test("names no JDK for Gradle when the worktree has none", () => {
    const settings = trustedImportSettings("/wt", plan, []) as { import: { gradle: object } };
    expect(settings.import.gradle).not.toHaveProperty("java");
  });
});

describe("process options", () => {
  test("every JVM gets the hosts file, quoted for a path with spaces, and no way out", () => {
    const options = importJavaToolOptions("/Application Support/hosts");
    expect(options).toContain('-Djdk.net.hosts.file="/Application Support/hosts"');
    expect(options).toContain("-Dhttp.proxyHost=127.0.0.1");
    expect(options).toContain("-Dhttps.proxyHost=127.0.0.1");
  });

  test("Gradle's client registers daemons apart, with an idle timeout", () => {
    expect(gradleClientFlags("/d")).toEqual([
      "-Dorg.gradle.daemon.registry.base=/d",
      "-Dorg.gradle.daemon.idletimeout=600000",
    ]);
  });
});

describe("stopGradleDaemons", () => {
  test("reads process ids from the logs Gradle names by them", () => {
    const registry = dir({
      "9.8.2/daemon-101.out.log": "",
      "9.8.2/registry.bin": "",
      "7.6.4/daemon-202.out.log": "",
    });
    expect(
      registeredDaemons(registry)
        .map(({ pid }) => pid)
        .toSorted((a, b) => a - b),
    ).toEqual([101, 202]);
  });

  /** A process with `log` as its output, as a daemon has its log. */
  function holding(log: string) {
    return Bun.spawn(["sleep", "60"], { stdout: Bun.file(log) });
  }

  test("stops the process that holds its log, and forgets the registry", async () => {
    const registry = dir({ "9.8.2/.keep": "" });
    const placeholder = path.join(registry, "9.8.2", "held.log");
    const daemon = holding(placeholder);
    renameSync(placeholder, path.join(registry, "9.8.2", `daemon-${daemon.pid}.out.log`));
    await stopGradleDaemons(registry);
    expect(await daemon.exited).toBe(143);
    expect(existsSync(registry)).toBe(false);
  });

  test("leaves a process alone that took the id of a daemon that is gone", async () => {
    const other = Bun.spawn(["sleep", "60"]);
    const registry = dir({ [`9.8.2/daemon-${other.pid}.out.log`]: "" });
    await stopGradleDaemons(registry);
    expect(other.exitCode).toBeNull();
    expect(existsSync(registry)).toBe(false);
    other.kill();
    await other.exited;
  });

  test("carries on past a daemon that has already gone", async () => {
    const registry = dir({ "9.8.2/daemon-999999.out.log": "" });
    await stopGradleDaemons(registry);
    expect(existsSync(registry)).toBe(false);
  });

  test("has nothing to do without a registry", async () => {
    await stopGradleDaemons(path.join(scratch, "missing"));
  });
});

describe("importSignal", () => {
  const notify = (method: string, params: unknown) => ({ method, params });

  test("reads the project status, not other statuses", () => {
    expect(
      importSignal(notify("language/status", { type: "ProjectStatus", message: "OK" })),
    ).toEqual({ kind: "status", ok: true });
    expect(
      importSignal(notify("language/status", { type: "ProjectStatus", message: "WARNING" })),
    ).toEqual({ kind: "status", ok: false });
    expect(
      importSignal(notify("language/status", { type: "ServiceReady", message: "OK" })),
    ).toBeNull();
  });

  test("reads Gradle's incompatibility with the JDK", () => {
    const params = { eventType: 300, data: { message: "Can't use Java 25 and Gradle 7.6.4." } };
    expect(importSignal(notify("language/eventNotification", params))).toEqual({
      kind: "incompatible",
      message: "Can't use Java 25 and Gradle 7.6.4.",
    });
    expect(
      importSignal(notify("language/eventNotification", { eventType: 200, data: [] })),
    ).toBeNull();
  });

  test("reads errors on build files and project folders, not on Java files", () => {
    const diagnostics = [
      { severity: 2, message: "Plugin execution not covered" },
      { severity: 1, message: "Offline / Missing artifact a:b:1" },
    ];
    const publish = (uri: string, list: unknown[] = diagnostics) =>
      importSignal(notify("textDocument/publishDiagnostics", { uri, diagnostics: list }));
    expect(publish("file:///w/pom.xml")).toEqual({
      kind: "build-file",
      uri: "file:///w/pom.xml",
      error: "Offline / Missing artifact a:b:1",
    });
    expect(publish("file:///w/svc", [{ severity: 2, message: "warning" }])).toEqual({
      kind: "build-file",
      uri: "file:///w/svc",
      error: null,
    });
    expect(publish("file:///w/App.java")).toBeNull();
  });

  test("shows the line of a long marker that says what is missing", () => {
    const signal = importSignal(
      notify("textDocument/publishDiagnostics", {
        uri: "file:///w/svc",
        diagnostics: [
          {
            severity: 1,
            message:
              "The supplied phased action failed.\nCould not resolve all dependencies.\nMore",
          },
        ],
      }),
    );
    expect(signal).toMatchObject({ error: "Could not resolve all dependencies." });
  });

  test("only parses frames that may matter", () => {
    expect(mayCarryImportSignal('{"method":"language/status"}')).toBe(true);
    expect(mayCarryImportSignal('{"method":"language/eventNotification"}')).toBe(true);
    const publish = (uri: string) =>
      `{"method":"textDocument/publishDiagnostics","params":{"uri":"${uri}","diagnostics":[]}}`;
    expect(mayCarryImportSignal(publish("file:///w/pom.xml"))).toBe(true);
    expect(mayCarryImportSignal(publish("file:///w/App.java"))).toBe(false);
    expect(mayCarryImportSignal('{"id":1,"result":[]}')).toBe(false);
  });
});

describe("projectIssue", () => {
  const plan = (hasMaven = true, gradle = false) => ({
    projects: { dirs: [], hasMaven, gradleRoots: gradle ? ["/w"] : [] },
    blocked: [],
    gradleHome: null,
    gradleCommand: gradle ? "./gradlew testClasses" : null,
  });
  const state = (over: Partial<ImportState> = {}): ImportState => ({
    statusOk: null,
    incompatible: null,
    buildFileErrors: new Map(),
    ...over,
  });

  test("has nothing to say about a project still loading, or one that loaded", () => {
    expect(projectIssue(plan(), state())).toBeNull();
    expect(projectIssue(plan(), state({ statusOk: true }))).toBeNull();
  });

  test("says what to run after a failed import, by build tool", () => {
    const issue = projectIssue(plan(true, true), state({ statusOk: false }));
    expect(issue?.detail).toContain("mvn test-compile or ./gradlew testClasses");
    expect(issue?.detail).toContain("Click to reload.");
  });

  test("a missing dependency counts even after a good import, other errors don't", () => {
    const missing = new Map([["file:///w/pom.xml", "Offline / Missing artifact a:b:1"]]);
    const issue = projectIssue(plan(), state({ statusOk: true, buildFileErrors: missing }));
    expect(issue?.detail).toContain("Missing artifact a:b:1");
    const other = new Map([["file:///w/pom.xml", "Failed to execute mojo x"]]);
    expect(projectIssue(plan(), state({ statusOk: true, buildFileErrors: other }))).toBeNull();
  });

  test("an incompatible JDK is about the JDK, not about anything missing", () => {
    const issue = projectIssue(
      plan(false, true),
      state({ statusOk: false, incompatible: "Can't use Java 25 and Gradle 7.6.4." }),
    );
    expect(issue?.detail).toContain("Choose a JDK it can run on.");
    expect(issue?.detail).not.toContain("gradlew testClasses");
  });

  test("reports a held-back project before the server says anything", () => {
    const issue = projectIssue(
      { ...plan(false, true), blocked: [{ root: "/w", message: "Run ./gradlew once." }] },
      state(),
    );
    expect(issue?.detail).toContain("Run ./gradlew once.");
  });
});

test("applyImportSignal keeps errors per file until the file's clear", () => {
  const state: ImportState = { statusOk: null, incompatible: null, buildFileErrors: new Map() };
  applyImportSignal(state, { kind: "build-file", uri: "a", error: "e" });
  applyImportSignal(state, { kind: "status", ok: false });
  expect([...state.buildFileErrors]).toEqual([["a", "e"]]);
  expect(state.statusOk).toBe(false);
  applyImportSignal(state, { kind: "build-file", uri: "a", error: null });
  expect(state.buildFileErrors.size).toBe(0);
});

test("a project issue is reported once per change", () => {
  const seen: string[] = [];
  const stop = onJavaProjectIssueChange((wtPath) => seen.push(wtPath));
  const issue = { label: "l", detail: "d" };
  setJavaProjectIssue("/w", issue);
  setJavaProjectIssue("/w", { ...issue });
  expect(getJavaProjectIssue("/w")).toEqual(issue);
  setJavaProjectIssue("/w", null);
  stop();
  setJavaProjectIssue("/w", issue);
  setJavaProjectIssue("/w", null);
  expect(seen).toEqual(["/w", "/w"]);
});
