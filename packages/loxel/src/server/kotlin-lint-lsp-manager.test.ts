import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { ServerWebSocket } from "bun";

import { KotlinLintLspManager } from "./kotlin-lint-lsp-manager";
import { fileUri } from "./lsp-file-uri";

// Drives the manager the way the Monaco client does, with stand-in tools on `PATH`. Each records its
// arguments and working directory, and reports a violation for every file named in `<file>.bad`.

const canRun = process.platform !== "win32";
const originalPath = process.env.PATH;

const FAKE_DETEKT = (version: string) => `#!/bin/sh
if [ "$1" = "--version" ]; then echo "Picked up JAVA_TOOL_OPTIONS: -Dx=y" >&2; echo "${version}"; exit 0; fi
echo "$PWD|$*" >> "$RUNS_DIR/detekt"
[ -f "$RUNS_DIR/fail" ] && { echo "bad config" >&2; exit 1; }
[ -f "$RUNS_DIR/hang" ] && { sleep 300 & echo $! > "$RUNS_DIR/pid"; wait; }
input="" report=""
while [ $# -gt 0 ]; do
  case "$1" in
    --input) input="$input $2"; shift ;;
    --report) report="\${2#sarif:}"; shift ;;
  esac
  shift
done
results=""
for file in $(echo "$input" | tr ',' ' '); do
  [ -f "$file.bad" ] || continue
  [ -n "$results" ] && results="$results,"
  results="$results{\\"level\\":\\"warning\\",\\"ruleId\\":\\"detekt.style.MagicNumber\\",\\"message\\":{\\"text\\":\\"detekt says\\"},\\"locations\\":[{\\"physicalLocation\\":{\\"artifactLocation\\":{\\"uri\\":\\"file://$file\\"},\\"region\\":{\\"startLine\\":1,\\"startColumn\\":1}}}]}"
done
echo "{\\"runs\\":[{\\"results\\":[$results]}]}" > "$report"
[ -n "$results" ] && exit 2
exit 0
`;

const FAKE_KTLINT = `#!/bin/sh
echo "$PWD|$*" >> "$RUNS_DIR/ktlint"
report=""
entries=""
for arg in "$@"; do
  case "$arg" in
    --reporter=json,output=*) report="\${arg#--reporter=json,output=}" ;;
    --*) ;;
    *)
      [ -f "$arg.bad" ] || continue
      [ -n "$entries" ] && entries="$entries,"
      entries="$entries{\\"file\\":\\"$arg\\",\\"errors\\":[{\\"line\\":1,\\"column\\":1,\\"message\\":\\"ktlint says\\",\\"rule\\":\\"standard:x\\"}]}"
      ;;
  esac
done
echo "[$entries]" > "$report"
[ -n "$entries" ] && exit 1
exit 0
`;

interface Received {
  method?: string;
  id?: number;
  params?: {
    uri?: string;
    diagnostics?: { message: string; source: string }[];
    type?: number;
    message?: string;
  };
  result?: { capabilities?: unknown };
}

class FakeClient {
  readonly ws: ServerWebSocket<unknown>;
  readonly received: Received[] = [];
  private waiters: (() => void)[] = [];

  constructor(private readonly target: KotlinLintLspManager) {
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
      params: { textDocument: { uri: fileUri(file), languageId: "kotlin", version: 1, text: "" } },
    });
  }

  close(file: string): void {
    this.send({
      method: "textDocument/didClose",
      params: { textDocument: { uri: fileUri(file) } },
    });
  }

  /** The first message `match` accepts, waiting for it if it has not arrived. */
  async next(match: (message: Received) => boolean): Promise<Received> {
    let index = 0;
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
  async diagnostics(file: string, messages: string[]): Promise<void> {
    const wanted = [...messages].sort();
    let index = 0;
    for (;;) {
      for (; index < this.received.length; index++) {
        const message = this.received[index];
        if (message?.method !== "textDocument/publishDiagnostics") continue;
        if (message.params?.uri !== fileUri(file)) continue;
        const got = (message.params.diagnostics ?? []).map((d) => d.message).sort();
        if (JSON.stringify(got) === JSON.stringify(wanted)) return;
      }
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }
  }

  messages(): string[] {
    return this.received.flatMap((m) =>
      m.method === "window/showMessage" ? [m.params?.message ?? ""] : [],
    );
  }
}

let wt: string;
let bin: string;
let runsDir: string;
let manager: KotlinLintLspManager | undefined;

afterEach(async () => {
  manager?.destroy();
  manager = undefined;
  process.env.PATH = originalPath;
  delete process.env.RUNS_DIR;
  await Promise.all([wt, bin, runsDir].map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setUp(
  files: Record<string, string>,
  tools: { detekt?: string; ktlint?: boolean } = { detekt: "1.23.8", ktlint: true },
): Promise<FakeClient> {
  [wt, bin, runsDir] = (await Promise.all(
    ["wt", "bin", "runs"].map(async (name) =>
      realpath(await mkdtemp(join(tmpdir(), `kotlin-lint-${name}-`))),
    ),
  )) as [string, string, string];
  await write(files);
  if (tools.detekt) await writeTool("detekt", FAKE_DETEKT(tools.detekt));
  if (tools.ktlint) await writeTool("ktlint", FAKE_KTLINT);
  process.env.RUNS_DIR = runsDir;
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  manager = new KotlinLintLspManager();
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

async function writeTool(name: string, script: string): Promise<void> {
  await writeFile(join(bin, name), script);
  await chmod(join(bin, name), 0o755);
}

/** One `<cwd>|<arguments>` per run of `tool`. */
async function runs(tool: "detekt" | "ktlint"): Promise<string[]> {
  const text = await readFile(join(runsDir, tool), "utf-8").catch(() => "");
  return text.split("\n").filter(Boolean);
}

const BOTH = {
  "detekt.yml": "a: 1\n",
  ".editorconfig": "[*]\nktlint_code_style = intellij_idea\n",
};

describe.skipIf(!canRun)("KotlinLintLspManager", () => {
  test("answers the handshake with open and close sync only", async () => {
    const client = await setUp({});
    client.send({ id: 1, method: "initialize", params: { capabilities: {} } });
    const { result } = await client.next((m) => m.id === 1);
    expect(result?.capabilities).toEqual({ textDocumentSync: { openClose: true, change: 0 } });
  });

  test("both tools report on an opened file, each run from the home directory", async () => {
    const client = await setUp({ ...BOTH, "src/A.kt": "", "src/A.kt.bad": "" });
    const file = join(wt, "src/A.kt");
    client.open(file);
    await client.diagnostics(file, ["detekt says", "ktlint says"]);
    const home = await realpath(homedir());
    const [detekt] = await runs("detekt");
    const [ktlint] = await runs("ktlint");
    expect(detekt).toStartWith(`${home}|`);
    expect(ktlint).toStartWith(`${home}|`);
    expect(detekt).toContain(`--input ${file}`);
    expect(detekt).toContain(`--config ${join(wt, "detekt.yml")},`);
    expect(detekt).toContain(`--base-path ${wt}`);
    expect(detekt).not.toMatch(/--(plugins|classpath|baseline)/);
    expect(ktlint).toEndWith(` ${file}`);
    expect(ktlint).not.toMatch(/--(ruleset|baseline)|-R /);
  });

  test.each([
    ["2.0.0-alpha.6", (a: string, b: string) => `--input ${a} --input ${b}`],
    ["1.23.8", (a: string, b: string) => `--input ${a},${b}`],
  ] as const)("detekt %s takes several files its own way", async (version, inputs) => {
    const client = await setUp(
      { "detekt.yml": "a: 1\n", "A.kt": "", "B.kt": "", "A.kt.bad": "", "B.kt.bad": "" },
      { detekt: version },
    );
    const [a, b] = [join(wt, "A.kt"), join(wt, "B.kt")];
    client.open(a);
    client.open(b);
    await client.diagnostics(b, ["detekt says"]);
    expect((await runs("detekt")).join("\n")).toContain(inputs(a, b));
  });

  test("a config path detekt 1.x would split is a failed run, not a wrong one", async () => {
    const client = await setUp(
      {
        "lint,x/rules.yml": "a: 1\n",
        "build.gradle.kts":
          'plugins { id("dev.detekt") }\ndetekt { config = files("lint,x/rules.yml") }\n',
        "A.kt": "",
      },
      { detekt: "1.23.8" },
    );
    client.open(join(wt, "A.kt"));
    const notice = await client.next((m) => m.method === "window/showMessage");
    expect(notice.params?.message).toContain("comma or semicolon");
    expect(await runs("detekt")).toEqual([]);
  });

  test("a crash with no output still says something", async () => {
    const client = await setUp(
      { ".editorconfig": "[*]\nktlint_code_style = intellij_idea\n", "A.kt": "" },
      {},
    );
    await writeTool("ktlint", "#!/bin/sh\nexit 7\n");
    client.open(join(wt, "A.kt"));
    const notice = await client.next((m) => m.method === "window/showMessage");
    expect(notice.params?.message).toBe(
      "ktlint could not check the worktree: it ended with exit code 7 and no message.",
    );
  });

  test("a file with no signal starts no process, next to a subproject that has one", async () => {
    const client = await setUp({
      "sub/detekt.yml": "a: 1\n",
      "sub/A.kt": "",
      "sub/A.kt.bad": "",
      "other/B.kt": "",
      "other/B.kt.bad": "",
    });
    client.open(join(wt, "other/B.kt"));
    client.open(join(wt, "sub/A.kt"));
    await client.diagnostics(join(wt, "sub/A.kt"), ["detekt says"]);
    expect((await runs("detekt")).join("\n")).not.toContain("B.kt");
    expect(await runs("ktlint")).toEqual([]);
  });

  test("a change on disk re-checks only that open file, and clears what is fixed", async () => {
    const client = await setUp({
      ...BOTH,
      "A.kt": "",
      "A.kt.bad": "",
      "B.kt": "",
      "Closed.kt": "",
    });
    const [a, b] = [join(wt, "A.kt"), join(wt, "B.kt")];
    client.open(a);
    client.open(b);
    await client.diagnostics(a, ["detekt says", "ktlint says"]);
    const before = (await runs("ktlint")).length;
    await rm(`${a}.bad`);
    manager?.notifyWatchedFilesChanged(wt, [a, join(wt, "Closed.kt")]);
    await client.diagnostics(a, []);
    const later = (await runs("ktlint")).slice(before).join("\n");
    expect(later).toContain(a);
    expect(later).not.toContain(b);
    expect(later).not.toContain("Closed.kt");
  });

  test("a change to only closed files runs nothing", async () => {
    const client = await setUp({ ...BOTH, "A.kt": "", "A.kt.bad": "" });
    const a = join(wt, "A.kt");
    client.open(a);
    await client.diagnostics(a, ["detekt says", "ktlint says"]);
    const before = (await runs("ktlint")).length;
    manager?.notifyWatchedFilesChanged(wt, [join(wt, "Other.kt")]);
    // A config change runs next, behind anything the closed file would have scheduled.
    manager?.notifyWatchedFilesChanged(wt, [join(wt, ".editorconfig")]);
    await rm(`${a}.bad`);
    await client.diagnostics(a, []);
    expect((await runs("ktlint")).slice(before).join("\n")).not.toContain("Other.kt");
  });

  test("a config change re-checks open files, and a removed signal clears its tool", async () => {
    const client = await setUp({ ...BOTH, "A.kt": "", "A.kt.bad": "" });
    const a = join(wt, "A.kt");
    client.open(a);
    await client.diagnostics(a, ["detekt says", "ktlint says"]);
    await write({ ".editorconfig": "[*]\nindent_size = 4\n" });
    manager?.notifyWatchedFilesChanged(wt, [join(wt, ".editorconfig")]);
    await client.diagnostics(a, ["detekt says"]);
  });

  test("closing a file clears its diagnostics", async () => {
    const client = await setUp({ ...BOTH, "A.kt": "", "A.kt.bad": "" });
    const a = join(wt, "A.kt");
    client.open(a);
    await client.diagnostics(a, ["detekt says", "ktlint says"]);
    client.close(a);
    await client.diagnostics(a, []);
  });

  test("a missing tool is told once, and the other tool still reports", async () => {
    const client = await setUp(
      { ...BOTH, "A.kt": "", "A.kt.bad": "", "B.kt": "" },
      { ktlint: true },
    );
    const a = join(wt, "A.kt");
    client.open(a);
    await client.diagnostics(a, ["ktlint says"]);
    client.open(join(wt, "B.kt"));
    manager?.notifyWatchedFilesChanged(wt, [a]);
    await rm(`${a}.bad`);
    manager?.notifyWatchedFilesChanged(wt, [a]);
    await client.diagnostics(a, []);
    expect(client.messages()).toEqual([
      "This project uses detekt, which is not on your PATH. Install it, for example with `brew install detekt`, to see its diagnostics.",
    ]);
  });

  test("no JVM is told once", async () => {
    const client = await setUp({ "detekt.yml": "a: 1\n", "A.kt": "" }, {});
    await writeTool("detekt", "#!/bin/sh\necho 'Unable to locate a Java Runtime.' >&2\nexit 1\n");
    client.open(join(wt, "A.kt"));
    const notice = await client.next((m) => m.method === "window/showMessage");
    expect(notice.params?.message).toBe(
      "detekt needs Java, which is not on your PATH. Install a JDK and add it to your PATH to see its diagnostics.",
    );
  });

  test("a binary in the worktree does not run, even on PATH", async () => {
    const client = await setUp({ "detekt.yml": "a: 1\n", "tools/detekt": "", "A.kt": "" }, {});
    await writeFile(join(wt, "tools/detekt"), FAKE_DETEKT("1.23.8"));
    await chmod(join(wt, "tools/detekt"), 0o755);
    process.env.PATH = `${join(wt, "tools")}:/usr/bin:/bin`;
    client.open(join(wt, "A.kt"));
    const notice = await client.next((m) => m.method === "window/showMessage");
    expect(notice.params?.message).toContain("not on your PATH");
    expect(await runs("detekt")).toEqual([]);
  });

  test("a failed run says why and clears what is now stale", async () => {
    const client = await setUp({ "detekt.yml": "a: 1\n", "A.kt": "", "A.kt.bad": "" });
    const a = join(wt, "A.kt");
    client.open(a);
    await client.diagnostics(a, ["detekt says"]);
    await writeFile(join(runsDir, "fail"), "");
    manager?.notifyWatchedFilesChanged(wt, [a]);
    const notice = await client.next((m) => m.method === "window/showMessage");
    expect(notice.params?.type).toBe(1);
    expect(notice.params?.message).toBe("detekt could not check the worktree: bad config");
    await client.diagnostics(a, []);
  });

  test("ending the session stops the running tool, even behind a forking launcher", async () => {
    const client = await setUp({ "detekt.yml": "a: 1\n", "A.kt": "" });
    await writeFile(join(runsDir, "hang"), "");
    client.open(join(wt, "A.kt"));
    const pid = await until(async () => Number(await readFile(join(runsDir, "pid"), "utf-8")));
    manager?.destroy();
    await until(() => {
      try {
        process.kill(pid, 0);
        return 0;
      } catch {
        return 1;
      }
    });
  });
});

/** Resolves once `read` gives a truthy value, yielding between tries; the test timeout bounds it. */
async function until<T>(read: () => T | Promise<T>): Promise<T> {
  for (;;) {
    const value = await Promise.resolve()
      .then(read)
      .catch(() => null);
    if (value) return value;
    await Bun.sleep(10);
  }
}
