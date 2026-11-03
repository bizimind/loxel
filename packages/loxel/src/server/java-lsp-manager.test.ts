import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { isJdkInWorktree } from "./java-env";
import {
  canRunJdtls,
  dropUnusableActions,
  dropWillRename,
  firstJavaFile,
  indentationOf,
  javaRuntimesSetting,
  javaSettings,
  jdtlsHostCrossed,
  jdtlsArgs,
  jdtlsDataDir,
  JavaLspManager,
  latestLogMessage,
  noJdkReason,
  trustedJavaSettings,
} from "./java-lsp-manager";
import { getJavaProjectIssue, type ImportPlan, setJavaProjectIssue } from "./java-project-import";
import { fileUri } from "./lsp-file-uri";
import type { WtLspSession } from "./stdio-lsp-manager";

const scratch = mkdtempSync(path.join(tmpdir(), "java-lsp-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("jdtlsHostCrossed", () => {
  test("reports only a change after the first look", () => {
    expect(jdtlsHostCrossed(null, true)).toBe(false);
    expect(jdtlsHostCrossed(null, false)).toBe(false);
    expect(jdtlsHostCrossed(false, true)).toBe(true);
    expect(jdtlsHostCrossed(true, false)).toBe(true);
    expect(jdtlsHostCrossed(true, true)).toBe(false);
  });
});

describe("canRunJdtls", () => {
  const wt = realpathSync(mkdtempSync(path.join(scratch, "wt-host-")));
  const runtime = (majorVersion: number, home = scratch) => ({
    path: home,
    majorVersion,
    version: String(majorVersion),
    implementor: null,
  });
  const untrusted = { wtPath: wt, repoTrusted: false };

  test("takes Java 25 or newer", () => {
    expect(canRunJdtls([], untrusted)).toBe(false);
    expect(canRunJdtls([runtime(21), runtime(17)], untrusted)).toBe(false);
    expect(canRunJdtls([runtime(25)], untrusted)).toBe(true);
    expect(canRunJdtls([runtime(26), runtime(8)], untrusted)).toBe(true);
  });

  test("takes a JDK inside the worktree only once the repository is trusted", () => {
    const inside = path.join(wt, "jdk");
    mkdirSync(inside);
    expect(canRunJdtls([runtime(25, inside)], untrusted)).toBe(false);
    expect(canRunJdtls([runtime(25, inside)], { wtPath: wt, repoTrusted: true })).toBe(true);
  });

  test("the reason says which it is", () => {
    expect(noJdkReason([])).toContain("Install one");
    expect(noJdkReason([{ majorVersion: 21 }])).toContain("Install one");
    expect(noJdkReason([{ majorVersion: 25 }])).toContain("inside the repository");
  });
});

describe("javaSettings", () => {
  test("starts with project import off", () => {
    expect(javaSettings([])).toMatchObject({
      import: { maven: { enabled: false }, gradle: { enabled: false }, exclusions: ["**"] },
      autobuild: { enabled: false },
    });
  });
});

describe("trustedJavaSettings", () => {
  const projects = { dirs: [], hasMaven: true, gradleRoots: [] };
  const plan = { projects, blocked: [], gradleHome: null, gradleCommand: null };
  const runtimes = [{ name: "JavaSE-21", path: "/jdk", default: true as const }];

  test("loads projects, with the runtimes next to the build-file setting", () => {
    expect(trustedJavaSettings("/wt", plan, runtimes)).toMatchObject({
      import: { maven: { enabled: true }, gradle: { enabled: true } },
      configuration: { updateBuildConfiguration: "automatic", runtimes },
      telemetry: { enabled: false },
      implementationCodeLens: "none",
    });
  });
});

describe("isJdkInWorktree", () => {
  const wt = realpathSync(mkdtempSync(path.join(scratch, "wt-")));
  const inside = path.join(wt, "jdk");
  mkdirSync(inside);
  const outside = realpathSync(mkdtempSync(path.join(scratch, "jdk-")));

  test("compares real paths", () => {
    expect(isJdkInWorktree(inside, wt)).toBe(true);
    expect(isJdkInWorktree(outside, wt)).toBe(false);
    const link = path.join(scratch, "link-to-inside");
    symlinkSync(inside, link);
    expect(isJdkInWorktree(link, wt)).toBe(true);
  });

  test("counts a path that cannot be read", () => {
    expect(isJdkInWorktree(path.join(scratch, "missing"), wt)).toBe(true);
  });
});

describe("javaRuntimesSetting", () => {
  const jdk = (majorVersion: number, name: string) => ({
    path: path.join(scratch, "jdks", name),
    majorVersion,
    version: String(majorVersion),
    implementor: null,
  });
  const jdk25 = jdk(25, "25");
  const jdk21a = jdk(21, "21a");
  const jdk21b = jdk(21, "21b");
  const jdk8 = jdk(8, "8");
  mkdirSync(path.join(jdk25.path, "lib"), { recursive: true });
  writeFileSync(path.join(jdk25.path, "lib", "src.zip"), "");
  mkdirSync(jdk8.path, { recursive: true });
  writeFileSync(path.join(jdk8.path, "src.zip"), "");

  test("gives each level its newest JDK, with sources where they exist", () => {
    expect(javaRuntimesSetting([jdk25, jdk21a, jdk21b, jdk8], null)).toEqual([
      { name: "JavaSE-25", path: jdk25.path, sources: path.join(jdk25.path, "lib", "src.zip") },
      { name: "JavaSE-21", path: jdk21a.path },
      { name: "JavaSE-1.8", path: jdk8.path, sources: path.join(jdk8.path, "src.zip") },
    ]);
  });

  test("makes the worktree's JDK the default, in its level's place", () => {
    const [newest, level21] = javaRuntimesSetting([jdk25, jdk21a, jdk21b], jdk21b);
    expect(newest?.default).toBeUndefined();
    expect(level21).toEqual({ name: "JavaSE-21", path: jdk21b.path, default: true });
  });
});

describe("jdtlsArgs", () => {
  const home = path.join(scratch, "jdtls");
  mkdirSync(path.join(home, "plugins"), { recursive: true });
  writeFileSync(path.join(home, "plugins", "org.eclipse.equinox.launcher_1.jar"), "");

  test("runs the launcher jar with the state directories and no name resolution", () => {
    const args = jdtlsArgs({ home, configuration: "/c", data: "/d", hosts: "/h" });
    expect(args).toContain("-Djdk.net.hosts.file=/h");
    expect(args).toContain("-Djava.import.generatesMetadataFilesAtProjectRoot=false");
    expect(args.slice(-5)).toEqual([
      path.join(home, "plugins", "org.eclipse.equinox.launcher_1.jar"),
      "-configuration",
      "/c",
      "-data",
      "/d",
    ]);
  });

  test("only a trusted server gets the daemon flags and the larger heap", () => {
    const paths = { home, configuration: "/c", data: "/d", hosts: "/h" };
    const restricted = jdtlsArgs(paths);
    expect(restricted).toContain("-Xmx1G");
    expect(restricted.join(" ")).not.toContain("org.gradle");
    const trusted = jdtlsArgs(paths, true);
    expect(trusted).toContain("-Xmx2G");
    expect(trusted).toContain("-Dorg.gradle.daemon.registry.base=/d/gradle-daemons");
  });

  test("fails on an incomplete install", () => {
    const empty = path.join(scratch, "empty");
    mkdirSync(path.join(empty, "plugins"), { recursive: true });
    expect(() => jdtlsArgs({ home: empty, configuration: "", data: "", hosts: "" })).toThrow();
  });
});

test("jdtlsDataDir keeps same-named worktrees apart", () => {
  expect(jdtlsDataDir("/a/project")).not.toBe(jdtlsDataDir("/b/project"));
  expect(jdtlsDataDir("/a/project")).toBe(jdtlsDataDir("/a/project"));
});

test("jdtlsDataDir keeps a trusted server's imported projects from a restricted one", () => {
  expect(jdtlsDataDir("/a/project", true)).not.toBe(jdtlsDataDir("/a/project"));
});

test("forgetWorktree deletes a removed worktree's restricted workspace directory", async () => {
  const manager = new JavaLspManager();
  const data = jdtlsDataDir("/removed/project");
  mkdirSync(data, { recursive: true });
  try {
    manager.forgetWorktree("/removed/project");
    expect(existsSync(data)).toBe(false);
  } finally {
    await manager.destroy();
  }
});

describe("dropWillRename", () => {
  test("removes the capability and keeps the rest of the initialize response", () => {
    const fileOperations: Record<string, unknown> = { willRename: { filters: [] }, didCreate: {} };
    const message = { result: { capabilities: { workspace: { fileOperations } } } };
    expect(dropWillRename(message)).toBe(true);
    expect(fileOperations).toEqual({ didCreate: {} });
  });

  test("leaves other messages alone", () => {
    expect(dropWillRename({ result: { contents: "willRename" } })).toBe(false);
    expect(dropWillRename({ method: "window/logMessage" })).toBe(false);
  });
});

describe("dropUnusableActions", () => {
  test("removes actions Loxel cannot carry out", () => {
    const message = {
      result: [
        { title: "Organize imports", kind: "source.organizeImports" },
        { title: "Ignore compiler problem(s)", kind: "quickfix" },
        { title: "Change signature", command: { command: "java.action.applyRefactoringCommand" } },
      ],
    };
    expect(dropUnusableActions(message)).toBe(true);
    expect(message.result).toEqual([{ title: "Organize imports", kind: "source.organizeImports" }]);
  });

  test("leaves a response with nothing to drop", () => {
    expect(dropUnusableActions({ result: [{ title: "Extract to field" }] })).toBe(false);
    expect(dropUnusableActions({ result: { items: [] } })).toBe(false);
  });
});

describe("firstJavaFile", () => {
  const root = path.join(scratch, "scan");
  mkdirSync(path.join(root, "node_modules/x"), { recursive: true });
  mkdirSync(path.join(root, ".hidden"), { recursive: true });
  writeFileSync(path.join(root, "node_modules/x/Skipped.java"), "");
  writeFileSync(path.join(root, ".hidden/Skipped.java"), "");

  test("skips dependency and hidden folders, and finds nothing there", async () => {
    expect(await firstJavaFile(root)).toBeNull();
  });

  test("finds a source file, the shallowest first", async () => {
    mkdirSync(path.join(root, "src/deep/er"), { recursive: true });
    writeFileSync(path.join(root, "src/deep/er/Deep.java"), "");
    writeFileSync(path.join(root, "src/Top.java"), "");
    expect(await firstJavaFile(root)).toBe(fileUri(path.join(root, "src/Top.java")));
  });

  test("treats an unreadable or missing folder as empty", async () => {
    expect(await firstJavaFile(path.join(root, "missing"))).toBeNull();
  });
});

describe("indentationOf", () => {
  test("reads spaces and tabs from the first indented line", () => {
    expect(indentationOf("class A {\n  int a;\n}\n")).toEqual({ tabSize: 2, insertSpaces: true });
    expect(indentationOf("class A {\n\tint a;\n}\n")).toEqual({ tabSize: 4, insertSpaces: false });
  });

  test("skips the continuation lines of comments", () => {
    const text = "/**\n * Doc\n */\nclass A {\n    int a;\n}\n";
    expect(indentationOf(text)).toEqual({ tabSize: 4, insertSpaces: true });
  });

  test("has no answer for a file with no indentation", () => {
    expect(indentationOf("class A {}\n")).toBeNull();
  });
});

describe("latestLogMessage", () => {
  test("returns the last message of the newest log", () => {
    const dir = path.join(scratch, "logs");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "1.log"), "!MESSAGE old\n");
    utimesSync(path.join(dir, "1.log"), 1, 1);
    writeFileSync(path.join(dir, "2.log"), "!ENTRY x\n!MESSAGE first\n!MESSAGE last\nstack\n");
    expect(latestLogMessage(dir, 0)).toBe("last");
  });

  test("has no answer without a readable log", () => {
    expect(latestLogMessage(path.join(scratch, "nowhere"), 0)).toBeNull();
  });

  test("ignores logs from before this run", () => {
    const dir = path.join(scratch, "old-logs");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "1.log"), "!MESSAGE old\n");
    utimesSync(path.join(dir, "1.log"), 1, 1);
    expect(latestLogMessage(dir, 5000)).toBeNull();
  });
});

describe("JavaLspManager, trusted", () => {
  /** A manager with its sessions' lifecycle in reach, and no process or client behind them. */
  class TestManager extends JavaLspManager {
    addLive(session: WtLspSession): void {
      this.sessions.set(session.ws, session);
    }

    close(session: WtLspSession): void {
      this.onSessionClosed(session);
    }

    frame(session: WtLspSession, body: string): void {
      this.handleServerFrame(session, body);
    }

    plan(wtPath: string, plan: ImportPlan): void {
      this["importPlans"].set(wtPath, plan);
    }

    initialize(session: WtLspSession): void {
      this["jdkSubscriptions"].set(session, () => {});
    }

    settled(session: WtLspSession): Promise<void> | undefined {
      return this["projectFollowers"].get(session);
    }
  }

  function fixture(repoTrusted = true) {
    const wtPath = realpathSync(mkdtempSync(path.join(scratch, "wt-session-")));
    const written: string[] = [];
    const session = {
      ws: { send: () => 0, close: () => {} },
      proc: {
        exited: Promise.resolve(0),
        stdin: {
          write: (data: string | Uint8Array) => {
            if (typeof data !== "string") written.push(Buffer.from(data).toString());
          },
          flush: () => {},
        },
      },
      wtPath,
      repoTrusted,
      stdoutBuf: Buffer.alloc(0),
      documentContents: new Map(),
    } as unknown as WtLspSession;
    const manager = new TestManager();
    const plan: ImportPlan = {
      projects: { dirs: [], hasMaven: true, gradleRoots: [] },
      blocked: [],
      gradleHome: null,
      gradleCommand: null,
    };
    manager.plan(wtPath, plan);
    return { manager, plan, session, wtPath, written };
  }

  const WARNING = JSON.stringify({
    jsonrpc: "2.0",
    method: "language/status",
    params: { type: "ProjectStatus", message: "WARNING" },
  });

  test("a live session's failed import reaches the user", () => {
    const { manager, session, wtPath } = fixture();
    manager.addLive(session);
    manager.frame(session, WARNING);
    expect(getJavaProjectIssue(wtPath)?.detail).toContain("mvn test-compile");
    setJavaProjectIssue(wtPath, null);
  });

  test("the last frames of a closed session don't", () => {
    const { manager, session, wtPath } = fixture();
    manager.frame(session, WARNING);
    expect(getJavaProjectIssue(wtPath)).toBeNull();
  });

  test("a repeated close leaves what a newer server reported alone", () => {
    const { manager, session, wtPath } = fixture();
    const issue = { label: "l", detail: "from the newer server" };
    setJavaProjectIssue(wtPath, { label: "l", detail: "from this server" });
    manager.close(session);
    expect(getJavaProjectIssue(wtPath)).toBeNull();
    setJavaProjectIssue(wtPath, issue);
    manager.close(session);
    expect(getJavaProjectIssue(wtPath)).toEqual(issue);
    setJavaProjectIssue(wtPath, null);
  });

  test("asks the server to import a build file in a new folder", async () => {
    const { manager, session, wtPath, written } = fixture();
    manager.addLive(session);
    manager.initialize(session);
    mkdirSync(path.join(wtPath, "mod"));
    writeFileSync(path.join(wtPath, "mod", "pom.xml"), "");
    manager.notifyWatchedFilesChanged(wtPath, [path.join(wtPath, "mod", "pom.xml")]);
    await manager.settled(session);
    expect(written.filter((frame) => frame.includes("java.project.import"))).toHaveLength(1);
  });

  test("doesn't ask again for a folder it knows", async () => {
    const { manager, session, wtPath, written } = fixture();
    manager.addLive(session);
    manager.initialize(session);
    writeFileSync(path.join(wtPath, "pom.xml"), "");
    const file = path.join(wtPath, "pom.xml");
    manager.notifyWatchedFilesChanged(wtPath, [file]);
    manager.notifyWatchedFilesChanged(wtPath, [file]);
    await manager.settled(session);
    expect(written.filter((frame) => frame.includes("java.project.import"))).toHaveLength(1);
  });

  test("imports a project no longer held back, with the new settings first", async () => {
    const { manager, plan, session, wtPath, written } = fixture();
    const root = path.join(wtPath, "svc");
    mkdirSync(root);
    writeFileSync(path.join(root, "pom.xml"), "");
    const projects = { dirs: [root], hasMaven: true, gradleRoots: [] };
    manager.plan(wtPath, { ...plan, projects, blocked: [{ root, message: "m" }] });
    manager.addLive(session);
    manager.initialize(session);
    manager.notifyWatchedFilesChanged(wtPath, [path.join(root, "pom.xml")]);
    await manager.settled(session);
    expect(
      written.map((frame) => (frame.includes("java.project.import") ? "import" : "settings")),
    ).toEqual(["settings", "import"]);
    setJavaProjectIssue(wtPath, null);
  });

  test("sends nothing before the client initialized", async () => {
    const { manager, session, wtPath, written } = fixture();
    manager.addLive(session);
    writeFileSync(path.join(wtPath, "pom.xml"), "");
    manager.notifyWatchedFilesChanged(wtPath, [path.join(wtPath, "pom.xml")]);
    await manager.settled(session);
    expect(written).toEqual([]);
  });

  test("a change in an untrusted repository sends no import", async () => {
    const { manager, session, wtPath, written } = fixture(false);
    manager.addLive(session);
    manager.initialize(session);
    writeFileSync(path.join(wtPath, "pom.xml"), "");
    manager.notifyWatchedFilesChanged(wtPath, [path.join(wtPath, "pom.xml")]);
    expect(manager.settled(session)).toBeUndefined();
    expect(written).toEqual([]);
  });
});

describe("JavaLspManager, closing a session", () => {
  class ClosingManager extends JavaLspManager {
    close(session: WtLspSession): void {
      this.onSessionClosed(session);
    }
  }

  /** Every process a test started, ended here whatever the test's outcome. */
  const started: number[] = [];
  afterEach(() => {
    for (const pid of started.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });

  /** Neither gone, nor killed and only waiting to be collected. */
  function isRunning(pid: number): boolean {
    const state = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]).stdout.toString();
    return state.trim() !== "" && !state.startsWith("Z");
  }

  /** A grandchild's end raises no event here, so this asks `ps` until it is gone. */
  async function untilGone(pid: number): Promise<void> {
    while (isRunning(pid)) await Bun.sleep(20);
  }

  /** The first pid a stream prints. */
  async function pidPrinted(stream: ReadableStream<Uint8Array>): Promise<number> {
    let text = "";
    for await (const chunk of stream) {
      text += Buffer.from(chunk).toString();
      if (text.includes("\n")) break;
    }
    return Number(text.trim());
  }

  /** A shell that starts a `sleep` in a process group of its own, and prints its pid. */
  const TREE = "(set -m; /bin/sleep 30 & echo $! >&2; wait) & wait";

  /** A stand-in for jdtls, whose build started a process in another process group. */
  async function server() {
    const proc = Bun.spawn(["/bin/sh", "-c", TREE], { stdin: "ignore", stderr: "pipe" });
    started.push(proc.pid);
    const child = await pidPrinted(proc.stderr);
    started.push(child);
    return { proc, child };
  }

  /** A stand-in for one of the worktree's Gradle daemons, holding its log, with a build child. */
  async function daemon(registry: string) {
    mkdirSync(path.join(registry, "9.8.2"), { recursive: true });
    const placeholder = path.join(registry, "9.8.2", "held.log");
    const proc = Bun.spawn(["/bin/sh", "-c", TREE], {
      stdin: "ignore",
      stdout: Bun.file(placeholder),
      stderr: "pipe",
    });
    started.push(proc.pid);
    const child = await pidPrinted(proc.stderr);
    started.push(child);
    renameSync(placeholder, path.join(registry, "9.8.2", `daemon-${proc.pid}.out.log`));
    return { proc, child };
  }

  function session(proc: Bun.Subprocess, repoTrusted: boolean) {
    const wtPath = realpathSync(mkdtempSync(path.join(scratch, "wt-close-")));
    const registry = path.join(jdtlsDataDir(wtPath, true), "gradle-daemons");
    const value = { ws: {}, proc, wtPath, repoTrusted } as unknown as WtLspSession;
    return { session: value, registry };
  }

  test("ends the server, its daemons and what both started, and forgets the registry", async () => {
    const jdtls = await server();
    const { session: closed, registry } = session(jdtls.proc, true);
    const gradle = await daemon(registry);
    const manager = new ClosingManager();
    manager.close(closed);
    await Promise.all([
      jdtls.proc.exited,
      gradle.proc.exited,
      untilGone(jdtls.child),
      untilGone(gradle.child),
    ]);
    expect(jdtls.proc.signalCode).toBe("SIGKILL");
    expect(gradle.proc.signalCode).toBe("SIGKILL");
    await manager.destroy();
    expect(existsSync(registry)).toBe(false);
  });

  test("ends a dead server's daemons, and leaves a process that took a stale entry's id", async () => {
    const jdtls = Bun.spawn(["/usr/bin/true"]);
    await jdtls.exited;
    const { session: closed, registry } = session(jdtls, true);
    const gradle = await daemon(registry);
    const bystander = Bun.spawn(["/bin/sleep", "30"]);
    started.push(bystander.pid);
    writeFileSync(path.join(registry, "9.8.2", `daemon-${bystander.pid}.out.log`), "");
    new ClosingManager().close(closed);
    await Promise.all([gradle.proc.exited, untilGone(gradle.child)]);
    expect(isRunning(bystander.pid)).toBe(true);
  });

  test("ends a restricted server's tree, without reading the trusted registry", async () => {
    const jdtls = await server();
    const { session: closed, registry } = session(jdtls.proc, false);
    const gradle = await daemon(registry);
    new ClosingManager().close(closed);
    await Promise.all([jdtls.proc.exited, untilGone(jdtls.child)]);
    expect(isRunning(gradle.proc.pid)).toBe(true);
  });
});
