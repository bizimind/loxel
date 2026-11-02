import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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

import type { ServerWebSocket } from "bun";

import { fileUri } from "./lsp-file-uri";

// Drives the manager the way the Monaco client does, with a stand-in golangci-lint and go on `PATH`.
// The stand-in records each run and copies `<runs>/report.json` to the report path it is given.

const stateDir = mkdtempSync(join(tmpdir(), "golangci-lsp-state-"));
process.env.LOXEL_STATE_DIR = stateDir;

const { getRepoTrustStatus, setRepoTrusted } = await import("./repo-trust");
const { GolangciLintLspManager } = await import("./golangci-lint-lsp-manager");

const canRun = process.platform !== "win32";
const originalPath = process.env.PATH;

const FAKE_GO = `#!/bin/sh
echo '{"GOVERSION":"go1.27.3","GOROOT":"/goroot","GOPATH":"/gopath","GOMODCACHE":"/gopath/pkg/mod","GOMOD":"/dev/null","GOWORK":"","GOFLAGS":""}'
`;

const fakeLint = (runs: string, version: string) => `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "$PWD" > "${runs}/version-cwd"
  echo "golangci-lint has version ${version} built with go1.27.0 from x on y"
  exit 0
fi
echo "$PWD|$GOPROXY|$GOTOOLCHAIN|$*" >> "${runs}/runs"
echo "start" >> "${runs}/order"
report=""
while [ $# -gt 0 ]; do
  [ "$1" = "--output.json.path" ] && report="$2"
  shift
done
echo "stats: stdout is not the report"
[ -f "${runs}/during" ] && sh "${runs}/during"
if [ -f "${runs}/hang" ]; then sleep 300 & echo $! > "${runs}/pid"; wait; fi
[ -f "${runs}/report.json" ] && cp "${runs}/report.json" "$report"
[ -f "${runs}/stderr" ] && cat "${runs}/stderr" >&2
code=0
[ -f "${runs}/exit" ] && code="$(cat "${runs}/exit")"
echo "end" >> "${runs}/order"
exit "$code"
`;

interface Diagnostic {
  message: string;
  source: string;
  code: string;
  range: { start: { line: number; character: number } };
}

interface Received {
  method?: string;
  id?: number;
  params?: { uri?: string; diagnostics?: Diagnostic[]; message?: string };
  result?: { capabilities?: unknown };
}

type Manager = InstanceType<typeof GolangciLintLspManager>;

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
      params: { textDocument: { uri: fileUri(file), languageId: "go", version: 1, text: "" } },
    });
  }

  /** The first message from `from` on that `match` accepts, waiting for it. */
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

  /** Waits for a publish on `file` holding exactly `messages`, from message `from` on. */
  diagnostics(file: string, messages: string[], from = 0): Promise<Received> {
    return this.next(
      (message) =>
        message.method === "textDocument/publishDiagnostics" &&
        message.params?.uri === fileUri(file) &&
        JSON.stringify(message.params.diagnostics?.map((d) => d.message)) ===
          JSON.stringify(messages),
      from,
    );
  }

  notice(part: string): Promise<Received> {
    return this.next(
      (message) =>
        message.method === "window/showMessage" && !!message.params?.message?.includes(part),
    );
  }

  notices(): string[] {
    return this.received.flatMap((m) =>
      m.method === "window/showMessage" ? [m.params?.message ?? ""] : [],
    );
  }

  published(file: string): number {
    return this.received.filter(
      (m) => m.method === "textDocument/publishDiagnostics" && m.params?.uri === fileUri(file),
    ).length;
  }
}

let dirs: string[] = [];
let manager: Manager | undefined;
let wt: string;
let bin: string;
let runs: string;

const CONFIG = 'version: "2"\nlinters:\n  enable: [errcheck]\n';

afterEach(async () => {
  manager?.destroy();
  manager = undefined;
  process.env.PATH = originalPath;
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs = [];
});

afterAll(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

async function tempDir(name: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), `golangci-lsp-${name}-`)));
  dirs.push(dir);
  return dir;
}

async function writeIn(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    const file = join(root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text);
  }
}

/** A git repository, trusted unless told otherwise. */
async function makeRepo(files: Record<string, string>, trusted = true): Promise<string> {
  const repo = await tempDir("wt");
  await mkdir(join(repo, ".git"));
  await writeIn(repo, files);
  if (trusted) setRepoTrusted(repo, true);
  return repo;
}

async function writeTool(name: string, script: string, dir = bin): Promise<void> {
  await writeFile(join(dir, name), script);
  await chmod(join(dir, name), 0o755);
}

async function setUp(
  files: Record<string, string>,
  { trusted = true, version = "2.15.0" }: { trusted?: boolean; version?: string | null } = {},
): Promise<FakeClient> {
  bin = await tempDir("bin");
  runs = await tempDir("runs");
  wt = await makeRepo(files, trusted);
  await writeTool("go", FAKE_GO);
  if (version) await writeTool("golangci-lint", fakeLint(runs, version));
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  manager = new GolangciLintLspManager(0);
  return connect(wt);
}

function connect(worktree: string): FakeClient {
  if (!manager) throw new Error("no manager");
  const client = new FakeClient(manager);
  manager.createSession(client.ws, worktree);
  return client;
}

function issue(file: string, Text: string, FromLinter = "errcheck") {
  return { FromLinter, Text, Severity: "", Pos: { Filename: file, Line: 1, Column: 1 } };
}

async function report(...issues: unknown[]): Promise<void> {
  await writeFile(join(runs, "report.json"), JSON.stringify({ Issues: issues, Report: {} }));
  await writeFile(join(runs, "exit"), issues.length > 0 ? "1" : "0");
}

async function runLog(): Promise<string[]> {
  try {
    return (await readFile(join(runs, "runs"), "utf8")).trim().split("\n");
  } catch {
    return [];
  }
}

/** Waits until the session has handed everything off: a marker run for `sentinel`'s package. */
async function settle(client: FakeClient, sentinel: string): Promise<void> {
  // A report naming the sentinel: runs go in order, so it arriving means earlier ones finished.
  await writeFile(join(runs, "exit"), "1");
  await writeFile(
    join(runs, "report.json"),
    JSON.stringify({ Issues: [issue(sentinel, "settled")], Report: {} }),
  );
  const from = client.received.length;
  manager?.notifyWatchedFilesChanged(wt, [sentinel]);
  await client.diagnostics(sentinel, ["settled"], from);
}

const GO_FILE = "package a\n";

const SOURCE = "package a\n\nvar x = 1\n";
const FIXABLE = {
  FromLinter: "lint",
  Text: "found",
  Severity: "",
  Pos: { Line: 3, Column: 5 },
  SuggestedFixes: [
    {
      Message: "rename it",
      // `x` on line 3.
      TextEdits: [{ Pos: 15, End: 16, NewText: Buffer.from("y").toString("base64") }],
    },
  ],
};
const ALL_ACTIONS = ["lint: rename it", "lint: Disable for this line"];

let nextRequest = 1000;

/** The code actions at `line`, with what the request asks for in `context`. */
async function requestActions(
  client: FakeClient,
  file: string,
  line: number,
  context: Record<string, unknown>,
): Promise<{ title: string }[]> {
  const id = nextRequest++;
  const position = { line, character: 4 };
  client.send({
    id,
    method: "textDocument/codeAction",
    params: {
      textDocument: { uri: fileUri(file) },
      range: { start: position, end: position },
      context: { diagnostics: [], ...context },
    },
  });
  const answer = await client.next((message) => message.id === id);
  return answer.result as unknown as { title: string }[];
}

async function actionTitles(
  client: FakeClient,
  file: string,
  context: Record<string, unknown> = {},
): Promise<string[]> {
  return (await requestActions(client, file, 2, context)).map((action) => action.title);
}

function fixableIssue(file: string) {
  return { ...FIXABLE, Pos: { ...FIXABLE.Pos, Filename: file } };
}

function openWith(client: FakeClient, file: string, text: string): void {
  client.send({
    method: "textDocument/didOpen",
    params: { textDocument: { uri: fileUri(file), languageId: "go", version: 1, text } },
  });
}

function change(client: FakeClient, file: string, text: string, version = 2): void {
  client.send({
    method: "textDocument/didChange",
    params: { textDocument: { uri: fileUri(file), version }, contentChanges: [{ text }] },
  });
}

/** A file with a fixable issue, open with its text in the buffer and reported on. */
async function fixableFile(): Promise<{ client: FakeClient; file: string }> {
  const client = await setUp({ "go.mod": "module a\n", ".golangci.yml": CONFIG, "a.go": SOURCE });
  const file = join(wt, "a.go");
  await report(fixableIssue(file));
  openWith(client, file, SOURCE);
  await client.diagnostics(file, ["found"]);
  return { client, file };
}

/** Runs a trusted worktree's check to its end: runs go in order, so earlier ones are done. */
async function trustedSiblingRun(): Promise<void> {
  const sibling = await makeRepo({
    "go.mod": "module sibling\n",
    ".golangci.yml": CONFIG,
    "s.go": GO_FILE,
  });
  const file = join(sibling, "s.go");
  await report(issue(file, "sibling"));
  const client = connect(sibling);
  client.open(file);
  await client.diagnostics(file, ["sibling"]);
}

async function untilFile(file: string): Promise<string> {
  for (;;) {
    const text = await readFile(file, "utf8").catch(() => "");
    if (text.trim()) return text.trim();
    await Bun.sleep(5);
  }
}

describe.skipIf(!canRun)("GolangciLintLspManager", () => {
  test("answers the handshake", async () => {
    const client = await setUp({});
    client.send({ id: 1, method: "initialize", params: {} });
    const answer = await client.next((message) => message.id === 1);
    expect(answer.result?.capabilities).toEqual({
      textDocumentSync: { openClose: true, change: 1 },
      codeActionProvider: { codeActionKinds: ["quickfix"] },
    });
  });

  test("runs on the package directory from its module, and publishes the report", async () => {
    const client = await setUp({
      "go.mod": "module a\n",
      ".golangci.yml": CONFIG,
      "pkg/a.go": "package pkg\n\nfunc F() {}\n",
    });
    const file = join(wt, "pkg/a.go");
    await report(issue(file, "unchecked"));
    client.open(file);
    const published = await client.diagnostics(file, ["unchecked"]);
    const diagnostic = published.params?.diagnostics?.[0];
    expect(diagnostic?.source).toBe("golangci-lint");
    expect(diagnostic?.code).toBe("errcheck");
    const [run] = await runLog();
    const [cwd, goproxy, gotoolchain, args] = (run ?? "").split("|");
    expect(cwd).toBe(wt);
    expect(goproxy).toBe("off");
    expect(gotoolchain).toBe("local");
    expect(args).toStartWith(`run --config ${join(wt, ".golangci.yml")} --output.json.path `);
    expect(args).toContain("--fix=false");
    expect(args).toContain("--issues-exit-code=1");
    expect(args).toContain("--allow-parallel-runners");
    expect(args).toContain("--path-mode abs");
    expect(args).toEndWith(" ./pkg/");
    expect(await readFile(join(runs, "version-cwd"), "utf8")).toBe("/\n");
  });

  test("uses the nearest module and config for a nested module", async () => {
    const client = await setUp({
      "go.mod": "module a\n",
      ".golangci.yml": CONFIG,
      "a.go": GO_FILE,
      "sub/go.mod": "module sub\n",
      "sub/a.go": GO_FILE,
    });
    const file = join(wt, "sub/a.go");
    await report(issue(file, "nested"));
    client.open(file);
    await client.diagnostics(file, ["nested"]);
    const [run] = await runLog();
    expect(run?.split("|")[0]).toBe(join(wt, "sub"));
    expect(run).toContain(`--config ${join(wt, ".golangci.yml")}`);
    expect(run).toEndWith(" ./");
  });

  test("a save re-runs, and replaces what was reported in that package only", async () => {
    const client = await setUp({
      "go.mod": "module a\n",
      ".golangci.yml": CONFIG,
      "x/a.go": GO_FILE,
      "y/b.go": GO_FILE,
    });
    const a = join(wt, "x/a.go");
    const b = join(wt, "y/b.go");
    await report(issue(a, "first a"), issue(b, "first b"));
    client.open(a);
    client.open(b);
    await client.diagnostics(a, ["first a"]);
    await client.diagnostics(b, ["first b"]);

    // Reports an issue in y too; the run covers only x.
    await report(issue(b, "out of scope"));
    const from = client.received.length;
    manager?.notifyWatchedFilesChanged(wt, [a]);
    await client.diagnostics(a, [], from);
    expect(client.received.slice(from).some((m) => m.params?.uri === fileUri(b))).toBe(false);
    expect((await runLog()).at(-1)).toEndWith(" ./x/");
  });

  test("a config change re-runs what is open", async () => {
    const client = await setUp({
      "go.mod": "module a\n",
      ".golangci.yml": CONFIG,
      "a.go": GO_FILE,
    });
    const file = join(wt, "a.go");
    await report(issue(file, "before"));
    client.open(file);
    await client.diagnostics(file, ["before"]);
    await report(issue(file, "after"));
    manager?.notifyWatchedFilesChanged(wt, [join(wt, ".golangci.yml")]);
    await client.diagnostics(file, ["after"]);
  });

  test("a deleted package has its diagnostics cleared without a run", async () => {
    const client = await setUp({
      "go.mod": "module a\n",
      ".golangci.yml": CONFIG,
      "x/a.go": GO_FILE,
    });
    const file = join(wt, "x/a.go");
    await report(issue(file, "there"));
    client.open(file);
    await client.diagnostics(file, ["there"]);
    const before = (await runLog()).length;
    await rm(join(wt, "x"), { recursive: true });
    manager?.notifyWatchedFilesChanged(wt, [file]);
    await client.diagnostics(file, []);
    expect(await runLog()).toHaveLength(before);
  });

  test.each([
    ["config or flag error", "3", '{"Issues":[]}'],
    ["timeout", "4", '{"Issues":[]}'],
    ["no Go files", "5", ""],
    ["error logged with no error in its report", "7", '{"Issues":[]}'],
    ["error logged", "7", '{"Issues":[],"Report":{"Error":"no go.mod"}}'],
    ["no report", "0", "stats"],
    ["unknown exit", "2", '{"Issues":[]}'],
  ])("keeps what was reported on %s", async (_, exit, text) => {
    const client = await setUp({
      "go.mod": "module a\n",
      ".golangci.yml": CONFIG,
      "a.go": GO_FILE,
      "other/b.go": GO_FILE,
    });
    const file = join(wt, "a.go");
    await report(issue(file, "kept"));
    client.open(file);
    await client.diagnostics(file, ["kept"]);
    const published = client.published(file);

    await writeFile(join(runs, "exit"), exit);
    await writeFile(join(runs, "report.json"), text);
    await writeFile(join(runs, "stderr"), 'level=error msg="boom"\n');
    manager?.notifyWatchedFilesChanged(wt, [file]);
    await waitForRuns(2);
    await rm(join(runs, "stderr"));
    await settle(client, join(wt, "other/b.go"));
    expect(client.published(file)).toBe(published);
  });

  test("keeps what was reported when a run hits a compile error, and never shows it", async () => {
    const client = await setUp({
      "go.mod": "module a\n",
      ".golangci.yml": CONFIG,
      "a.go": GO_FILE,
      "other/b.go": GO_FILE,
    });
    const file = join(wt, "a.go");
    await report(issue(file, "kept"));
    client.open(file);
    await client.diagnostics(file, ["kept"]);
    const published = client.published(file);

    await report(issue(file, "typecheck says", "typecheck"), issue(file, "partial"));
    manager?.notifyWatchedFilesChanged(wt, [file]);
    await waitForRuns(2);
    await settle(client, join(wt, "other/b.go"));
    expect(client.published(file)).toBe(published);
  });

  test("a package its build constraints exclude does not spoil the others", async () => {
    const client = await setUp({
      "go.mod": "module a\n",
      ".golangci.yml": CONFIG,
      "a.go": GO_FILE,
      "tagged/t.go": "//go:build ignore\n\npackage t\n",
    });
    const file = join(wt, "a.go");
    const tagged = join(wt, "tagged");
    await writeFile(join(runs, "exit"), "7");
    await writeFile(
      join(runs, "report.json"),
      JSON.stringify({
        Issues: [issue(file, "still here")],
        Report: {
          Error: `typechecking error: build constraints exclude all Go files in ${tagged}`,
        },
      }),
    );
    client.open(file);
    client.open(join(tagged, "t.go"));
    await client.diagnostics(file, ["still here"]);
  });

  test("drops what gopls reports too", async () => {
    const client = await setUp({
      "go.mod": "module a\n",
      ".golangci.yml": CONFIG,
      "a.go": GO_FILE,
    });
    const file = join(wt, "a.go");
    await report(
      issue(file, "printf: wrong type", "govet"),
      issue(file, "shadow: declaration shadows", "govet"),
    );
    client.open(file);
    await client.diagnostics(file, ["shadow: declaration shadows"]);
  });

  test("runs nothing without a config, a module or Go files to check", async () => {
    const client = await setUp({
      "nomod/.golangci.yml": CONFIG,
      "nomod/a.go": GO_FILE,
      "mod/go.mod": "module a\n",
      "mod/a.go": GO_FILE,
      "mod/vendor/x/a.go": GO_FILE,
      "mod/testdata/a.go": GO_FILE,
    });
    client.open(join(wt, "nomod/a.go"));
    client.open(join(wt, "mod/a.go"));
    client.open(join(wt, "mod/vendor/x/a.go"));
    await writeFile(join(wt, "mod/.golangci.yml"), CONFIG);
    client.open(join(wt, "mod/vendor/x/a.go"));
    client.open(join(wt, "mod/testdata/a.go"));
    await report();
    await settle(client, join(wt, "mod/a.go"));
    for (const run of await runLog()) expect(run).toEndWith(" ./");
  });

  describe("trust", () => {
    test("an untrusted repository runs nothing and says so, and trusting starts runs", async () => {
      const client = await setUp(
        { "go.mod": "module a\n", ".golangci.yml": CONFIG, "a.go": GO_FILE },
        { trusted: false },
      );
      const file = join(wt, "a.go");
      client.open(file);
      expect(getRepoTrustStatus(wt).restrictions).toEqual(["golangci-lint doesn't run."]);
      await trustedSiblingRun();
      expect((await runLog()).filter((run) => run.startsWith(`${wt}|`))).toEqual([]);

      await report(issue(file, "after trust"));
      setRepoTrusted(wt, true);
      await client.diagnostics(file, ["after trust"]);
      expect((await runLog()).filter((run) => run.startsWith(`${wt}|`))).toHaveLength(1);
    });

    test("an untrusted repository without a config reports nothing", async () => {
      const client = await setUp({ "go.mod": "module a\n", "a.go": GO_FILE }, { trusted: false });
      client.open(join(wt, "a.go"));
      expect(getRepoTrustStatus(wt).restrictions).toEqual([]);
    });

    test("stopping to trust clears diagnostics, and starts nothing more", async () => {
      const client = await setUp({
        "go.mod": "module a\n",
        ".golangci.yml": CONFIG,
        "a.go": GO_FILE,
      });
      const file = join(wt, "a.go");
      await report(issue(file, "reported"));
      client.open(file);
      await client.diagnostics(file, ["reported"]);

      setRepoTrusted(wt, false);
      await client.diagnostics(file, []);
      expect(getRepoTrustStatus(wt).restrictions).toEqual(["golangci-lint doesn't run."]);
      manager?.notifyWatchedFilesChanged(wt, [file]);
      await trustedSiblingRun();
      expect((await runLog()).filter((run) => run.startsWith(`${wt}|`))).toHaveLength(1);
    });

    test("stopping to trust kills a run and whatever it started, and frees the queue", async () => {
      const client = await setUp({
        "go.mod": "module a\n",
        ".golangci.yml": CONFIG,
        "a.go": GO_FILE,
      });
      const file = join(wt, "a.go");
      await writeFile(join(runs, "hang"), "");
      client.open(file);
      const pid = Number(await untilFile(join(runs, "pid")));

      setRepoTrusted(wt, false);
      await rm(join(runs, "hang"));
      await trustedSiblingRun();
      expect(() => process.kill(pid, 0)).toThrow();
      expect(client.published(file)).toBe(0);
    });
  });

  describe("messages", () => {
    const PROJECT = { "go.mod": "module a\n", "a.go": GO_FILE };

    test("not installed", async () => {
      const client = await setUp({ ...PROJECT, ".golangci.yml": CONFIG }, { version: null });
      client.open(join(wt, "a.go"));
      await client.notice("found no golangci-lint v2");
    });

    test("a version manager's shim counts as not installed", async () => {
      const client = await setUp({ ...PROJECT, ".golangci.yml": CONFIG }, { version: null });
      const shims = join(await tempDir("mgr"), "shims");
      await mkdir(shims);
      await writeTool("golangci-lint", fakeLint(runs, "2.15.0"), shims);
      process.env.PATH = `${shims}:${bin}:/usr/bin:/bin`;
      client.open(join(wt, "a.go"));
      await client.notice("found no golangci-lint v2");
      expect(await runLog()).toEqual([]);
    });

    test("a binary inside the worktree counts as not installed", async () => {
      const client = await setUp({ ...PROJECT, ".golangci.yml": CONFIG }, { version: null });
      await mkdir(join(wt, "tools"));
      await writeTool("golangci-lint", fakeLint(runs, "2.15.0"), join(wt, "tools"));
      process.env.PATH = `${join(wt, "tools")}:${bin}:/usr/bin:/bin`;
      client.open(join(wt, "a.go"));
      await client.notice("found no golangci-lint v2");
      expect(await runLog()).toEqual([]);
    });

    test("a v1 binary", async () => {
      const client = await setUp({ ...PROJECT, ".golangci.yml": CONFIG }, { version: "1.64.8" });
      client.open(join(wt, "a.go"));
      await client.notice("is not v2.1");
      expect(await runLog()).toEqual([]);
    });

    test("a v2.0 binary", async () => {
      const client = await setUp({ ...PROJECT, ".golangci.yml": CONFIG }, { version: "2.0.2" });
      client.open(join(wt, "a.go"));
      await client.notice("is not v2.1");
      expect(await runLog()).toEqual([]);
    });

    test("a v1 config", async () => {
      const client = await setUp({ ...PROJECT, ".golangci.yml": "linters:\n  enable: [govet]\n" });
      client.open(join(wt, "a.go"));
      await client.notice("golangci-lint migrate");
      expect(await runLog()).toEqual([]);
    });

    test("a config it does not run, once, and clearing what was reported", async () => {
      const client = await setUp({ ...PROJECT, ".golangci.yml": CONFIG });
      const file = join(wt, "a.go");
      await report(issue(file, "reported"));
      client.open(file);
      await client.diagnostics(file, ["reported"]);
      const before = (await runLog()).length;

      const custom = 'version: "2"\nlinters.settings.custom:\n  x: {path: ./mine.so}\n';
      await writeFile(join(wt, ".golangci.yml"), custom);
      manager?.notifyWatchedFilesChanged(wt, [join(wt, ".golangci.yml")]);
      await client.notice("custom linters or a custom output");
      await client.diagnostics(file, []);
      const from = client.received.length;
      await writeFile(join(wt, ".golangci.yml"), CONFIG);
      await report(issue(file, "back"));
      manager?.notifyWatchedFilesChanged(wt, [join(wt, ".golangci.yml")]);
      await client.diagnostics(file, ["back"], from);
      expect((await runLog()).length).toBe(before + 1);
      expect(client.notices()).toHaveLength(1);
    });

    test("an unreadable config", async () => {
      const client = await setUp({ ...PROJECT, ".golangci.yml": "version: [" });
      client.open(join(wt, "a.go"));
      await client.notice("could not read");
      expect(await runLog()).toEqual([]);
    });

    test("the first line of stderr on a config error", async () => {
      const client = await setUp({ ...PROJECT, ".golangci.yml": CONFIG });
      await writeFile(join(runs, "exit"), "3");
      await writeFile(
        join(runs, "stderr"),
        "Error: you are using a configuration file for golangci-lint v2 with golangci-lint v1\nThe command is terminated\n",
      );
      client.open(join(wt, "a.go"));
      const notice = await client.notice("could not run with .golangci.yml");
      expect(notice.params?.message).toEndWith(
        ": you are using a configuration file for golangci-lint v2 with golangci-lint v1",
      );
    });
  });

  test("maps reports back through a symlink, in the worktree and to it", async () => {
    await setUp({ "go.mod": "module a\n", ".golangci.yml": CONFIG, "real/a.go": GO_FILE });
    const linked = join(await tempDir("link"), "wt");
    await symlink(wt, linked);
    await symlink(join(wt, "real"), join(wt, "alias"));
    const client = connect(linked);
    const real = join(wt, "real/a.go");
    await report(issue(real, "through links"));
    const file = join(linked, "alias/a.go");
    client.open(file);
    await client.diagnostics(file, ["through links"]);
  });

  test("runs one at a time across worktrees", async () => {
    const client = await setUp({
      "go.mod": "module a\n",
      ".golangci.yml": CONFIG,
      "a.go": GO_FILE,
    });
    const otherWt = await makeRepo({
      "go.mod": "module b\n",
      ".golangci.yml": CONFIG,
      "b.go": GO_FILE,
    });
    const other = connect(otherWt);
    const fileA = join(wt, "a.go");
    const fileB = join(otherWt, "b.go");
    await report(issue(fileA, "one"), issue(fileB, "one"));
    client.open(fileA);
    other.open(fileB);
    await Promise.all([client.diagnostics(fileA, ["one"]), other.diagnostics(fileB, ["one"])]);
    expect((await readFile(join(runs, "order"), "utf8")).trim().split("\n")).toEqual([
      "start",
      "end",
      "start",
      "end",
    ]);
  });

  describe("code actions", () => {
    test("offers the fixes and nolint for what is under the range", async () => {
      const { client, file } = await fixableFile();
      expect(await actionTitles(client, file)).toEqual(ALL_ACTIONS);
      expect(await requestActions(client, file, 0, {})).toEqual([]);
    });

    test("an edit takes them away, and undoing it brings them back", async () => {
      const { client, file } = await fixableFile();
      change(client, file, `// edited\n${SOURCE}`);
      expect(await actionTitles(client, file)).toEqual([]);
      change(client, file, SOURCE);
      expect(await actionTitles(client, file)).toEqual(ALL_ACTIONS);
    });

    test("a file changed on disk takes them away, before any new run", async () => {
      const { client, file } = await fixableFile();
      await writeFile(file, `// changed\n${SOURCE}`);
      expect(await actionTitles(client, file)).toEqual([]);
    });

    test("a file that changes during the run gets none", async () => {
      const client = await setUp({
        "go.mod": "module a\n",
        ".golangci.yml": CONFIG,
        "a.go": SOURCE,
      });
      const file = join(wt, "a.go");
      await report(fixableIssue(file));
      const moved = `// moved\n${SOURCE}`;
      await writeFile(join(runs, "during"), `printf '%s' '${moved}' > '${file}'\n`);
      openWith(client, file, moved);
      await client.diagnostics(file, ["found"]);
      expect(await actionTitles(client, file)).toEqual([]);
    });

    test("a change undone during the run gets none", async () => {
      const client = await setUp({
        "go.mod": "module a\n",
        ".golangci.yml": CONFIG,
        "a.go": SOURCE,
      });
      const file = join(wt, "a.go");
      await report(fixableIssue(file));
      // The same bytes back, as if the run had read something else in between.
      await writeFile(
        join(runs, "during"),
        `printf '%s' '${SOURCE}' > '${file}'\ntouch -t 200001010000 '${file}'\n`,
      );
      openWith(client, file, SOURCE);
      await client.diagnostics(file, ["found"]);
      expect(await actionTitles(client, file)).toEqual([]);
    });

    test("edits name the buffer's version", async () => {
      const { client, file } = await fixableFile();
      change(client, file, SOURCE, 9);
      const [action] = await requestActions(client, file, 2, {});
      expect(action).toMatchObject({
        edit: { documentChanges: [{ textDocument: { uri: fileUri(file), version: 9 } }] },
      });
    });

    test("a buffer that was never the file gets none", async () => {
      const client = await setUp({
        "go.mod": "module a\n",
        ".golangci.yml": CONFIG,
        "a.go": SOURCE,
      });
      const file = join(wt, "a.go");
      await report(fixableIssue(file));
      openWith(client, file, `// unsaved\n${SOURCE}`);
      await client.diagnostics(file, ["found"]);
      expect(await actionTitles(client, file)).toEqual([]);
    });

    test("a closed file gets none", async () => {
      const { client, file } = await fixableFile();
      client.send({
        method: "textDocument/didClose",
        params: { textDocument: { uri: fileUri(file) } },
      });
      expect(await actionTitles(client, file)).toEqual([]);
    });

    test("only quick fixes: a request for another kind gets nothing", async () => {
      const { client, file } = await fixableFile();
      expect(await actionTitles(client, file, { only: ["source.fixAll"] })).toEqual([]);
      expect(await actionTitles(client, file, { only: ["quickfix"] })).toEqual(ALL_ACTIONS);
    });

    test("none in an untrusted repository", async () => {
      const client = await setUp(
        { "go.mod": "module a\n", ".golangci.yml": CONFIG, "a.go": SOURCE },
        { trusted: false },
      );
      const file = join(wt, "a.go");
      await report(fixableIssue(file));
      openWith(client, file, SOURCE);
      expect(await actionTitles(client, file)).toEqual([]);
      expect(await runLog()).toEqual([]);
    });

    test("none once trust goes", async () => {
      const { client, file } = await fixableFile();
      const from = client.received.length;
      setRepoTrusted(wt, false);
      await client.diagnostics(file, [], from);
      expect(await actionTitles(client, file)).toEqual([]);
    });

    test("a later run replaces what is offered", async () => {
      const { client, file } = await fixableFile();
      const from = client.received.length;
      await report({ ...fixableIssue(file), Text: "found again", SuggestedFixes: [] });
      manager?.notifyWatchedFilesChanged(wt, [file]);
      await client.diagnostics(file, ["found again"], from);
      expect(await actionTitles(client, file)).toEqual(["lint: Disable for this line"]);
    });
  });
});

/** Waits until the stand-in has finished `count` runs. */
async function waitForRuns(count: number): Promise<void> {
  for (;;) {
    const order = await readFile(join(runs, "order"), "utf8").catch(() => "");
    if (
      order
        .trim()
        .split("\n")
        .filter((line) => line === "end").length >= count
    )
      return;
    await Bun.sleep(5);
  }
}
