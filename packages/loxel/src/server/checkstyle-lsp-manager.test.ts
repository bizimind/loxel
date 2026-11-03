import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import type { ServerWebSocket } from "bun";

import { fileUri } from "./lsp-file-uri";

// Repository trust and the JDK choice live in the store database.
const stateDir = await mkdtemp(join(tmpdir(), "checkstyle-state-"));
process.env.LOXEL_STATE_DIR = stateDir;
const { CheckstyleLspManager } = await import("./checkstyle-lsp-manager");
const { refreshJavaEnv } = await import("./java-env");
const { getRepoTrustStatus, onRepoTrustStatusChange, setRepoTrusted } =
  await import("./repo-trust");
type Manager = InstanceType<typeof CheckstyleLspManager>;

// Drives the manager the way the Monaco client does, with a stand-in `checkstyle` on `PATH`. It
// records each run, reports a violation for every file with a `<file>.bad` next to it, fails to load
// a config other than one named `fine` while `$RUNS_DIR/config-fails` exists, and stops at a file with
// `<file>.broken` as Checkstyle stops at one that does not parse.

const canRun = process.platform !== "win32";
const originalPath = process.env.PATH;

const FAKE_CHECKSTYLE = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "Checkstyle version: 14.3.0"; exit 0; fi
config=""
previous=""
for arg in "$@"; do [ "$previous" = "-c" ] && config="$arg"; previous="$arg"; done
echo "$PWD|$JAVA_HOME|$JAVA_TOOL_OPTIONS|$*|$(cat "$config" 2>/dev/null)" >> "$RUNS_DIR/runs"
if [ -f "$RUNS_DIR/config-fails" ] && ! grep -q '"fine"' "$config" 2>/dev/null; then
  if [ -f "$RUNS_DIR/hold-failure" ]; then
    touch "$RUNS_DIR/holding"
    while [ -f "$RUNS_DIR/hold-failure" ]; do sleep 0.01; done
  fi
  echo "com.puppycrawl.tools.checkstyle.api.CheckstyleException: Property \\\${m} has not been set" >&2
  exit 254
fi
if [ -f "$RUNS_DIR/hang" ]; then sleep 300 & echo $! > "$RUNS_DIR/pid"; wait; fi
if [ -f "$RUNS_DIR/no-java" ]; then echo "Unable to locate a Java Runtime." >&2; exit 1; fi
if [ -f "$RUNS_DIR/old-java" ]; then echo "java.lang.UnsupportedClassVersionError: x" >&2; exit 1; fi
exec 3>&1
if [ -f "$RUNS_DIR/old-report" ]; then exec 1>"$RUNS_DIR/report"; fi
echo '<?xml version="1.0" encoding="UTF-8"?>'
echo '<checkstyle version="14.3.0">'
stopped=""
for arg in "$@"; do
  case "$arg" in
    *.java) ;;
    *) continue ;;
  esac
  echo "<file name=\\"$arg\\">"
  if [ -f "$arg.bad" ]; then
    column=$(cat "$RUNS_DIR/column" 2>/dev/null || echo 1)
    echo '<error line="1" column="'"$column"'" severity="warning" message="checkstyle says" source="com.puppycrawl.tools.checkstyle.checks.naming.MemberNameCheck"/>'
  fi
  echo "</file>"
  if [ -f "$arg.broken" ]; then stopped="$arg"; break; fi
done
echo '</checkstyle>'
# Before 14.2.0 a file that stops the run leaves no report on stdout at all.
if [ -f "$RUNS_DIR/old-report" ] && [ -z "$stopped" ]; then cat "$RUNS_DIR/report" >&3; fi
if [ -n "$stopped" ]; then
  echo "com.puppycrawl.tools.checkstyle.api.CheckstyleException: Exception was thrown while processing $stopped" >&2
  exit 254
fi
exit 0
`;

const GRADLE_PROJECT = {
  "settings.gradle": "",
  "build.gradle": "plugins { id 'checkstyle' }\n",
  "config/checkstyle/checkstyle.xml": "<module/>",
};

interface Received {
  method?: string;
  id?: number;
  params?: {
    uri?: string;
    diagnostics?: { message: string; source: string; code?: string }[];
    message?: string;
    type?: number;
  };
  result?: { capabilities?: unknown };
}

class FakeClient {
  readonly ws: ServerWebSocket<unknown>;
  readonly received: Received[] = [];
  private waiters: (() => void)[] = [];

  constructor(private readonly target: Manager) {
    const ws = {
      send: (data: string) => {
        this.received.push(JSON.parse(data) as Received);
        for (const waiter of this.waiters.splice(0)) waiter();
        return data.length;
      },
      close: () => {},
    };
    this.ws = ws as unknown as ServerWebSocket<unknown>;
  }

  send(message: Record<string, unknown>): void {
    this.target.handleMessage(this.ws, JSON.stringify({ jsonrpc: "2.0", ...message }));
  }

  open(file: string): void {
    this.send({
      method: "textDocument/didOpen",
      params: { textDocument: { uri: fileUri(file), languageId: "java", version: 1, text: "" } },
    });
  }

  close(file: string): void {
    this.send({
      method: "textDocument/didClose",
      params: { textDocument: { uri: fileUri(file) } },
    });
  }

  /** The first message from `from` on that `match` accepts, waiting for it if it hasn't arrived. */
  async next(match: (message: Received) => boolean, from = 0): Promise<Received> {
    let index = from;
    for (;;) {
      for (; index < this.received.length; index++) {
        const message = this.received[index];
        if (message && match(message)) return message;
      }
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }
  }

  /** Waits for the published diagnostics on `file` to hold exactly `messages`. */
  diagnostics(file: string, messages: string[], from = 0): Promise<Received> {
    return this.next(
      (message) =>
        message.method === "textDocument/publishDiagnostics" &&
        message.params?.uri === fileUri(file) &&
        JSON.stringify((message.params.diagnostics ?? []).map((d) => d.message)) ===
          JSON.stringify(messages),
      from,
    );
  }

  notice(pattern: RegExp): Promise<Received> {
    return this.next(
      (message) =>
        message.method === "window/showMessage" && pattern.test(message.params?.message ?? ""),
    );
  }

  notices(): string[] {
    return this.received.flatMap((m) =>
      m.method === "window/showMessage" ? [m.params?.message ?? ""] : [],
    );
  }
}

let wt: string;
let bin: string;
let runsDir: string;
let manager: Manager | undefined;

afterEach(async () => {
  manager?.destroy();
  manager = undefined;
  process.env.PATH = originalPath;
  delete process.env.RUNS_DIR;
  delete process.env.JAVA_HOME;
  await Promise.all([wt, bin, runsDir].map((dir) => rm(dir, { recursive: true, force: true })));
});

afterAll(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

interface SetUpOptions {
  trusted?: boolean;
  tool?: boolean;
}

async function setUp(
  files: Record<string, string>,
  { trusted = true, tool = true }: SetUpOptions = {},
): Promise<FakeClient> {
  [wt, bin, runsDir] = (await Promise.all(
    ["wt", "bin", "runs"].map(async (name) =>
      realpath(await mkdtemp(join(tmpdir(), `checkstyle-${name}-`))),
    ),
  )) as [string, string, string];
  await write(files);
  if (tool) await writeTool(join(bin, "checkstyle"));
  process.env.RUNS_DIR = runsDir;
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  setRepoTrusted(wt, trusted);
  manager = new CheckstyleLspManager(0);
  const client = new FakeClient(manager);
  manager.createSession(client.ws, wt);
  return client;
}

async function write(files: Record<string, string>): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    const file = join(wt, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text);
  }
}

async function writeTool(file: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, FAKE_CHECKSTYLE);
  await chmod(file, 0o755);
}

/** A directory laid out like a JDK home, outside the worktree. */
async function makeJdk(name: string, version: string): Promise<string> {
  const home = join(bin, name);
  await mkdir(join(home, "bin"), { recursive: true });
  await mkdir(join(home, "lib"));
  for (const launcher of ["java", "javac"]) {
    await writeFile(join(home, "bin", launcher), "#!/bin/sh\n");
    await chmod(join(home, "bin", launcher), 0o755);
  }
  await writeFile(join(home, "lib", "ct.sym"), "");
  await writeFile(join(home, "release"), `JAVA_VERSION="${version}"\n`);
  return home;
}

async function runs(): Promise<string[]> {
  const text = await readFile(join(runsDir, "runs"), "utf8").catch(() => "");
  return text.split("\n").filter(Boolean);
}

/** A file in the project, marked to report a violation. */
async function badFile(name = "A"): Promise<string> {
  const file = join(wt, `src/main/java/${name}.java`);
  await write({
    [`src/main/java/${name}.java`]: "class A {}\n",
    [`src/main/java/${name}.java.bad`]: "",
  });
  return file;
}

/**
 * Opens a file of a project whose config loads, and waits for it. Projects run in the order their
 * files were asked for, so whatever was asked for earlier has been dealt with by then.
 */
async function drain(client: FakeClient): Promise<void> {
  const file = join(wt, "other/src/main/java/Z.java");
  await write({
    "other/build.gradle":
      "apply plugin: 'checkstyle'\ncheckstyle { configFile = file('fine.xml') }\n",
    "other/fine.xml": '<module name="fine"/>',
    "other/src/main/java/Z.java": "class Z {}\n",
    "other/src/main/java/Z.java.bad": "",
  });
  client.open(file);
  await client.diagnostics(file, ["checkstyle says"]);
}

describe.skipIf(!canRun)("in a trusted repository", () => {
  test("answers the handshake with open and close sync only", async () => {
    const client = await setUp(GRADLE_PROJECT);
    client.send({ id: 1, method: "initialize", params: {} });
    const reply = await client.next((m) => m.id === 1);
    expect(reply.result?.capabilities).toEqual({
      textDocumentSync: { openClose: true, change: 0 },
    });
  });

  test("publishes a file's findings as it opens, clears them when fixed and saved", async () => {
    const client = await setUp(GRADLE_PROJECT);
    const file = await badFile();
    client.open(file);
    const reported = await client.diagnostics(file, ["checkstyle says"]);
    expect(reported.params?.diagnostics?.[0]).toMatchObject({
      source: "checkstyle",
      code: "MemberName",
    });
    await rm(`${file}.bad`);
    manager?.notifyWatchedFilesChanged(wt, [file]);
    await client.diagnostics(file, []);
  });

  test("runs the tool from a scratch directory, on the newest JDK, with nothing getting out", async () => {
    const client = await setUp(GRADLE_PROJECT);
    const file = await badFile();
    client.open(file);
    await client.diagnostics(file, ["checkstyle says"]);
    const [run = ""] = await runs();
    const [cwd = "", , options = "", args = ""] = run.split("|");
    expect(cwd.startsWith(wt)).toBe(false);
    expect(options).toContain("-Djdk.net.hosts.file=");
    expect(options).toContain("-Dhttp.proxyPort=9");
    expect(options).toContain("-DsocksProxyPort=9");
    // The text that was checked, from the run's scratch directory.
    expect(args).toContain(`/${basename(cwd)}/checkstyle.xml`);
    expect(args).toContain(file);
    expect(args).toContain("-f xml");
    expect(args).toContain("-p ");
  });

  test("a config's cacheFile goes from the text that runs", async () => {
    const client = await setUp({
      ...GRADLE_PROJECT,
      "config/checkstyle/checkstyle.xml":
        '<module name="Checker"><property name="cacheFile" value="x"/><property name="kept" value="y"/></module>',
    });
    const file = await badFile();
    client.open(file);
    await client.diagnostics(file, ["checkstyle says"]);
    const [run = ""] = await runs();
    const [, , , args = "", config = ""] = run.split("|");
    expect(args).not.toContain(join(wt, "config"));
    expect(config).toBe('<module name="Checker"><property name="kept" value="y"/></module>');
  });

  test("a file in a subproject belongs to its own config", async () => {
    const client = await setUp({
      ...GRADLE_PROJECT,
      "other/build.gradle":
        "apply plugin: 'checkstyle'\ncheckstyle { configFile = file('own.xml') }\n",
      "other/own.xml": '<module name="own"/>',
      "other/src/main/java/B.java": "class B {}\n",
      "other/src/main/java/B.java.bad": "",
    });
    const a = await badFile();
    const b = join(wt, "other/src/main/java/B.java");
    client.open(a);
    client.open(b);
    await client.diagnostics(a, ["checkstyle says"]);
    await client.diagnostics(b, ["checkstyle says"]);
    const all = await runs();
    const configs = all.map((run) => run.split("|").at(-1));
    expect(new Set(configs)).toEqual(new Set(["<module/>", '<module name="own"/>']));
  });

  test("a build without Checkstyle starts nothing, and says nothing", async () => {
    const client = await setUp({ "build.gradle": "plugins { id 'java' }\n" }, { trusted: true });
    const file = join(wt, "src/main/java/A.java");
    await write({ "src/main/java/A.java": "class A {}\n", "src/main/java/A.java.bad": "" });
    client.open(file);
    // The handshake is answered in order, so everything the open started has been decided.
    client.send({ id: 1, method: "shutdown" });
    await client.next((m) => m.id === 1);
    manager?.destroy();
    expect(await runs()).toEqual([]);
    expect(client.notices()).toEqual([]);
  });

  test("closing a file clears it, and a run while it closes publishes nothing for it", async () => {
    const client = await setUp(GRADLE_PROJECT);
    const file = await badFile();
    client.open(file);
    await client.diagnostics(file, ["checkstyle says"]);
    client.close(file);
    await client.diagnostics(file, []);
  });

  test("a file that doesn't parse is cleared, and those after it still get checked", async () => {
    const client = await setUp(GRADLE_PROJECT);
    const broken = await badFile("Broken");
    await write({ "src/main/java/Broken.java.broken": "" });
    await rm(`${broken}.bad`);
    const after = await badFile("After");
    client.open(broken);
    client.open(after);
    await client.diagnostics(after, ["checkstyle says"]);
    expect(client.notices()).toEqual([]);
  });

  test("a build file's change drops what was read and checks open files again", async () => {
    const client = await setUp({ "build.gradle": "plugins { id 'java' }\n" });
    const file = await badFile();
    client.open(file);
    await write(GRADLE_PROJECT);
    manager?.notifyWatchedFilesChanged(wt, [join(wt, "build.gradle")]);
    await client.diagnostics(file, ["checkstyle says"]);
  });

  test("a build that stops using it clears what it reported", async () => {
    const client = await setUp(GRADLE_PROJECT);
    const file = await badFile();
    client.open(file);
    await client.diagnostics(file, ["checkstyle says"]);
    await write({ "build.gradle": "plugins { id 'java' }\n" });
    manager?.notifyWatchedFilesChanged(wt, [join(wt, "build.gradle")]);
    await client.diagnostics(file, []);
  });

  test("before 14.2.0 too, a file that doesn't parse leaves the others checked", async () => {
    const client = await setUp(GRADLE_PROJECT);
    await writeFile(join(runsDir, "old-report"), "");
    const broken = await badFile("Broken");
    await write({ "src/main/java/Broken.java.broken": "" });
    await rm(`${broken}.bad`);
    const after = await badFile("After");
    client.open(broken);
    client.open(after);
    await client.diagnostics(after, ["checkstyle says"]);
    expect(client.notices()).toEqual([]);
  });

  test("a bundled config's columns count a tab as 8", async () => {
    const client = await setUp({
      "pom.xml": `<project><artifactId>a</artifactId><build><plugins><plugin><artifactId>maven-checkstyle-plugin</artifactId><configuration><configLocation>google_checks.xml</configLocation></configuration></plugin></plugins></build></project>`,
    });
    const file = join(wt, "src/main/java/A.java");
    await write({
      "src/main/java/A.java": "\t\tint bad_name = 1;\n",
      "src/main/java/A.java.bad": "",
    });
    await writeFile(join(runsDir, "column"), "21");
    client.open(file);
    const reported = await client.diagnostics(file, ["checkstyle says"]);
    expect(reported.params?.diagnostics?.[0]).toMatchObject({
      range: { start: { line: 0, character: 6 }, end: { line: 0, character: 14 } },
    });
    expect((await runs())[0]).toContain("-c /google_checks.xml");
  });

  test("a file deleted from disk is cleared, and doesn't fail the project", async () => {
    const client = await setUp(GRADLE_PROJECT);
    const file = await badFile();
    client.open(file);
    await client.diagnostics(file, ["checkstyle says"]);
    await rm(file);
    manager?.notifyWatchedFilesChanged(wt, [file]);
    await client.diagnostics(file, []);
    expect(client.notices()).toEqual([]);
  });

  test("ending the session stops a run, whole", async () => {
    const client = await setUp(GRADLE_PROJECT);
    await writeFile(join(runsDir, "hang"), "");
    const file = await badFile();
    client.open(file);
    const pidPath = join(runsDir, "pid");
    let pid = 0;
    while (!pid) {
      pid = Number(await readFile(pidPath, "utf8").catch(() => ""));
      await Bun.sleep(5);
    }
    expect(() => process.kill(pid, 0)).not.toThrow();
    manager?.destroySession(client.ws);
    let alive = true;
    while (alive) {
      try {
        process.kill(pid, 0);
        await Bun.sleep(5);
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });
});

describe.skipIf(!canRun)("a config that doesn't load", () => {
  test("is said once with what Checkstyle says and the pin, not tried again on saves", async () => {
    const client = await setUp({
      ...GRADLE_PROJECT,
      "build.gradle": "plugins { id 'checkstyle' }\ncheckstyle { toolVersion = '12.3.1' }\n",
    });
    await writeFile(join(runsDir, "config-fails"), "");
    const file = await badFile();
    client.open(file);
    const notice = await client.notice(/could not load/);
    expect(notice.params?.message).toBe(
      "Checkstyle 14.3.0 could not load config/checkstyle/checkstyle.xml: Property ${m} has not been set. This project pins Checkstyle 12.3.1.",
    );
    const before = (await runs()).length;
    // A save.
    manager?.notifyWatchedFilesChanged(wt, [file]);
    await drain(client);
    expect((await runs()).length).toBe(before + 1);
    expect(client.notices().length).toBe(1);
  });

  test("runs again once a config file changes", async () => {
    const client = await setUp(GRADLE_PROJECT);
    await writeFile(join(runsDir, "config-fails"), "");
    const file = await badFile();
    client.open(file);
    await client.notice(/could not load/);
    await rm(join(runsDir, "config-fails"));
    manager?.notifyWatchedFilesChanged(wt, [join(wt, "config/checkstyle/checkstyle.xml")]);
    await client.diagnostics(file, ["checkstyle says"]);
  });

  test("a config fixed during the run that failed gets tried again", async () => {
    const client = await setUp(GRADLE_PROJECT);
    await writeFile(join(runsDir, "config-fails"), "");
    const file = await badFile();
    await writeFile(join(runsDir, "hold-failure"), "");
    client.open(file);
    const held = join(runsDir, "holding");
    while (!(await Bun.file(held).exists())) await Bun.sleep(5);
    await rm(join(runsDir, "config-fails"));
    manager?.notifyWatchedFilesChanged(wt, [join(wt, "config/checkstyle/checkstyle.xml")]);
    await rm(join(runsDir, "hold-failure"));
    await client.diagnostics(file, ["checkstyle says"]);
  });

  test("a newer JDK on the machine tries it again, though the worktree's stays the same", async () => {
    const client = await setUp(GRADLE_PROJECT);
    process.env.JAVA_HOME = await makeJdk("chosen", "21.0.5");
    refreshJavaEnv(wt);
    await writeFile(join(runsDir, "config-fails"), "");
    const file = await badFile();
    client.open(file);
    await client.notice(/could not load/);
    await rm(join(runsDir, "config-fails"));
    const newer = await makeJdk("newer", "99.0.1");
    process.env.PATH = `${bin}:${join(newer, "bin")}:/usr/bin:/bin`;
    refreshJavaEnv(wt);
    await client.diagnostics(file, ["checkstyle says"]);
    expect((await runs()).at(-1)?.split("|")[1]).toBe(newer);
  });

  test("a JDK upgraded in place, at the same path, tries it again", async () => {
    const client = await setUp(GRADLE_PROJECT);
    const home = await makeJdk("in-place", "98.0.1");
    process.env.PATH = `${bin}:${join(home, "bin")}:/usr/bin:/bin`;
    refreshJavaEnv(wt);
    await writeFile(join(runsDir, "config-fails"), "");
    const file = await badFile();
    client.open(file);
    await client.notice(/could not load/);
    await rm(join(runsDir, "config-fails"));
    await writeFile(join(home, "release"), 'JAVA_VERSION="99.0.1"\n');
    refreshJavaEnv(wt);
    await client.diagnostics(file, ["checkstyle says"]);
  });

  test("a config that isn't in the repository runs nothing", async () => {
    const client = await setUp({
      "settings.gradle": "",
      "build.gradle": "plugins { id 'checkstyle' }\n",
    });
    const file = await badFile();
    client.open(file);
    const notice = await client.notice(/could not load/);
    expect(notice.params?.message).toContain("isn't in the repository");
    expect(await runs()).toEqual([]);
  });

  test("clears what an earlier run reported", async () => {
    const client = await setUp(GRADLE_PROJECT);
    const file = await badFile();
    client.open(file);
    await client.diagnostics(file, ["checkstyle says"]);
    await writeFile(join(runsDir, "config-fails"), "");
    manager?.notifyWatchedFilesChanged(wt, [join(wt, "config/checkstyle/checkstyle.xml")]);
    await client.diagnostics(file, []);
    await client.notice(/could not load/);
  });
});

describe.skipIf(!canRun)("the tool", () => {
  test("missing: says what to install once, and starts when it appears", async () => {
    const client = await setUp(GRADLE_PROJECT, { tool: false });
    const file = await badFile();
    client.open(file);
    const notice = await client.notice(/not on your PATH/);
    expect(notice.params?.message).toContain("brew install checkstyle");
    manager?.notifyWatchedFilesChanged(wt, [file]);
    await writeTool(join(bin, "checkstyle"));
    manager?.notifyWatchedFilesChanged(wt, [file]);
    await client.diagnostics(file, ["checkstyle says"]);
    expect(client.notices().length).toBe(1);
  });

  test("a version manager's shim isn't run", async () => {
    const client = await setUp(GRADLE_PROJECT, { tool: false });
    const shims = join(bin, "shims");
    await writeTool(join(shims, "checkstyle"));
    process.env.PATH = `${shims}:/usr/bin:/bin`;
    const file = await badFile();
    client.open(file);
    await client.notice(/version manager's shim/);
    expect(await runs()).toEqual([]);
  });

  test("one in the worktree isn't run", async () => {
    const client = await setUp(GRADLE_PROJECT, { tool: false });
    await writeTool(join(wt, "tools/checkstyle"));
    process.env.PATH = `${join(wt, "tools")}:/usr/bin:/bin`;
    const file = await badFile();
    client.open(file);
    await client.notice(/not on your PATH/);
    expect(await runs()).toEqual([]);
  });

  test("no Java, and a Java too old, each say so", async () => {
    const client = await setUp(GRADLE_PROJECT);
    await writeFile(join(runsDir, "no-java"), "");
    const file = await badFile();
    client.open(file);
    await client.notice(/needs Java/);
    await rm(join(runsDir, "no-java"));
    await writeFile(join(runsDir, "old-java"), "");
    manager?.notifyWatchedFilesChanged(wt, [file]);
    await client.notice(/newer JDK/);
  });
});

describe.skipIf(!canRun)("in an untrusted repository", () => {
  async function restricted(): Promise<void> {
    const reported = Promise.withResolvers<void>();
    const stop = onRepoTrustStatusChange(() => {
      if (getRepoTrustStatus(wt).restrictions.length > 0) reported.resolve();
    });
    if (getRepoTrustStatus(wt).restrictions.length > 0) reported.resolve();
    await reported.promise;
    stop();
  }

  test("nothing runs, the restriction is reported once, and trusting starts it", async () => {
    const client = await setUp(GRADLE_PROJECT, { trusted: false });
    const file = await badFile();
    client.open(file);
    await restricted();
    expect(getRepoTrustStatus(wt).restrictions).toEqual(["Checkstyle doesn't run."]);
    manager?.notifyWatchedFilesChanged(wt, [file]);
    expect(getRepoTrustStatus(wt).restrictions).toEqual(["Checkstyle doesn't run."]);
    expect(await runs()).toEqual([]);
    setRepoTrusted(wt, true);
    await client.diagnostics(file, ["checkstyle says"]);
  });

  test("a project without Checkstyle, or a machine without it, isn't asked about", async () => {
    const client = await setUp({ "build.gradle": "plugins { id 'java' }\n" }, { trusted: false });
    const file = await badFile();
    client.open(file);
    client.send({ id: 1, method: "shutdown" });
    await client.next((m) => m.id === 1);
    expect(getRepoTrustStatus(wt).restrictions).toEqual([]);
    expect(await runs()).toEqual([]);
  });

  test("a machine without the tool says nothing until there's trust", async () => {
    const client = await setUp(GRADLE_PROJECT, { trusted: false, tool: false });
    const file = await badFile();
    client.open(file);
    client.send({ id: 1, method: "shutdown" });
    await client.next((m) => m.id === 1);
    expect(client.notices()).toEqual([]);
    setRepoTrusted(wt, true);
    await client.notice(/not on your PATH/);
  });

  test("taking trust back during a batch starts none of its later projects", async () => {
    const client = await setUp({
      ...GRADLE_PROJECT,
      "other/build.gradle":
        "apply plugin: 'checkstyle'\ncheckstyle { configFile = file('fine.xml') }\n",
      "other/fine.xml": '<module name="fine"/>',
      "other/src/main/java/B.java": "class B {}\n",
      "other/src/main/java/B.java.bad": "",
    });
    await writeFile(join(runsDir, "config-fails"), "");
    await writeFile(join(runsDir, "hold-failure"), "");
    const file = await badFile();
    const other = join(wt, "other/src/main/java/B.java");
    client.open(file);
    client.open(other);
    const held = join(runsDir, "holding");
    while (!(await Bun.file(held).exists())) await Bun.sleep(5);
    setRepoTrusted(wt, false);
    await rm(join(runsDir, "hold-failure"));
    await restricted();
    expect((await runs()).filter((run) => run.includes('"fine"'))).toEqual([]);
  });

  test("taking trust back stops a run and clears its findings", async () => {
    const client = await setUp(GRADLE_PROJECT);
    const file = await badFile();
    client.open(file);
    await client.diagnostics(file, ["checkstyle says"]);
    setRepoTrusted(wt, false);
    await client.diagnostics(file, []);
    const before = (await runs()).length;
    manager?.notifyWatchedFilesChanged(wt, [file]);
    await restricted();
    expect((await runs()).length).toBe(before);
  });
});
