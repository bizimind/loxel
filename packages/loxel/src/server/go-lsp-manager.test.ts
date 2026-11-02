import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import type { ServerWebSocket } from "bun";

import { LSP_RESTART_CLOSE_CODE, LSP_START_FAILED_CLOSE_CODE } from "@/api/ws-protocol";
import { repeatUntil } from "@/test/repeat-until";
import "@/test/temp-state-dir";

import { GO_ENV, refreshGoEnv, subscribeGoEnv } from "./go-env";
import {
  GO_NOT_FOUND_REASON,
  GoLspManager,
  GOPLS_SETTINGS,
  goSetupProblem,
  withoutHiddenActions,
} from "./go-lsp-manager";
import { setGoChoice } from "./go-toolchain-store";

const roots: string[] = [];
let manager: GoLspManager | undefined;
const originalPath = process.env.PATH;
const originalHome = process.env.HOME;

afterEach(async () => {
  manager?.destroy();
  manager = undefined;
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

// Stands in for gopls: asks for each section, then reports the answers and its environment.
const FAKE_GOPLS = `#!${process.execPath}
let buffer = "";
const send = (msg) => {
  const body = JSON.stringify(msg);
  process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body);
};
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const end = buffer.indexOf("\\r\\n\\r\\n");
    if (end < 0) return;
    const length = Number(/Content-Length: (\\d+)/.exec(buffer)[1]);
    if (buffer.length < end + 4 + length) return;
    const msg = JSON.parse(buffer.slice(end + 4, end + 4 + length));
    buffer = buffer.slice(end + 4 + length);
    if (msg.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          args: process.argv.slice(2),
          self: process.argv[1],
          path: process.env.PATH,
          goEnv: [process.env.GOPROXY, process.env.GOTOOLCHAIN, process.env.GOSUMDB, process.env.GONOPROXY],
          clientConfiguration: msg.params.capabilities.workspace.configuration,
          capabilities: {
            codeActionProvider: { codeActionKinds: ["quickfix", "source.doc"] },
            executeCommandProvider: { commands: ["gopls.tidy", "gopls.doc"] },
          },
        },
      });
      send({
        jsonrpc: "2.0",
        id: 900,
        method: "workspace/configuration",
        params: { items: [{ section: "gopls" }, { section: "other" }] },
      });
    } else if (msg.id === 900) {
      send({ jsonrpc: "2.0", method: "test/configuration", params: msg.result });
      for (let i = 0; i < 2; i++) {
        send({
          jsonrpc: "2.0",
          method: "textDocument/publishDiagnostics",
          params: {
            uri: "file:///a.go",
            diagnostics: [
              { message: 'could not import a/b (no required module provides package "a/b")' },
            ],
          },
        });
      }
      send({ jsonrpc: "2.0", method: "test/repeated" });
    }
  }
});
`;

const GIT = Bun.which("git");

/**
 * Limit the PATH the manager sees to `dirs`, and `git`, which the trust check runs, alone in a
 * directory so no `go` comes with it. The spawn PATH adds `~/.local/bin` under `HOME`.
 */
async function restrictPath(...dirs: string[]): Promise<void> {
  process.env.HOME = await makeDir("go-home-");
  const gitDir = await makeDir("go-git-");
  await symlink(GIT ?? "git", join(gitDir, "git"));
  process.env.PATH = [...dirs, gitDir].join(delimiter);
}

/** Runs a gopls stand-in instead of the bundled binary. */
class TestGoLspManager extends GoLspManager {
  constructor(private readonly gopls: string) {
    super();
  }
  protected override resolveBundledBinary(): string {
    return this.gopls;
  }
}

/** Stands in for the WebSocket and the Monaco client behind it. */
function fakeSocket() {
  const frames: Record<string, unknown>[] = [];
  const waiters: (() => void)[] = [];
  let close: { code: number; reason: string } | undefined;
  const wake = () => {
    for (const waiter of waiters.splice(0)) waiter();
  };
  const ws = {
    send: (data: string) => {
      frames.push(JSON.parse(data));
      wake();
      return data.length;
    },
    close: (code: number, reason: string) => {
      close ??= { code, reason };
      wake();
    },
  } as unknown as ServerWebSocket<unknown>;
  const until = async <T>(read: () => T | undefined): Promise<T> => {
    for (;;) {
      const value = read();
      if (value !== undefined) return value;
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    }
  };
  return {
    ws,
    frames,
    closedWith: () => close,
    untilClosed: () => until(() => close),
    untilFrame: (match: (frame: Record<string, unknown>) => boolean) =>
      until(() => frames.find(match)),
  };
}

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { capabilities: {} },
});

describe("GoLspManager", () => {
  test("closes with a reason a user can act on when go is missing, and finds it once installed", async () => {
    const wt = await makeDir("go-wt-");
    const bin = await makeDir("go-bin-");
    const gopls = join(await makeDir("gopls-"), "gopls");
    await writeExecutable(gopls, FAKE_GOPLS);
    await restrictPath(bin);
    manager = new TestGoLspManager(gopls);

    if (Bun.which("go", { PATH: process.env.PATH }))
      throw new Error("go on the test's system dirs");
    const missing = fakeSocket();
    manager.createSession(missing.ws, wt);
    manager.handleMessage(missing.ws, INITIALIZE);
    expect(await missing.untilClosed()).toEqual({
      code: LSP_START_FAILED_CLOSE_CODE,
      reason: GO_NOT_FOUND_REASON,
    });
    manager.destroySession(missing.ws);

    await writeExecutable(join(bin, "go"), "#!/bin/sh\n");
    const found = fakeSocket();
    manager.createSession(found.ws, wt);
    manager.handleMessage(found.ws, INITIALIZE);
    await found.untilFrame((frame) => frame.id === 1);
  });

  test("does not count a go inside the worktree, and keeps the worktree off gopls's PATH", async () => {
    const wt = await makeDir("go-wt-");
    const wtBin = join(wt, "bin");
    await mkdir(wtBin);
    await writeExecutable(join(wtBin, "go"), "#!/bin/sh\n");
    const bin = await makeDir("go-bin-");
    const gopls = join(await makeDir("gopls-"), "gopls");
    await writeExecutable(gopls, FAKE_GOPLS);
    await restrictPath(wtBin, bin);
    manager = new TestGoLspManager(gopls);

    const missing = fakeSocket();
    manager.createSession(missing.ws, wt);
    expect((await missing.untilClosed()).code).toBe(LSP_START_FAILED_CLOSE_CODE);
    manager.destroySession(missing.ws);

    await writeExecutable(join(bin, "go"), "#!/bin/sh\n");
    const found = fakeSocket();
    manager.createSession(found.ws, wt);
    manager.handleMessage(found.ws, INITIALIZE);
    const { result } = (await found.untilFrame((frame) => frame.id === 1)) as {
      result: { args: string[]; path: string; goEnv: string[]; clientConfiguration: boolean };
    };
    expect(result.args).toEqual(["serve"]);
    expect(result.goEnv).toEqual([
      GO_ENV.GOPROXY,
      GO_ENV.GOTOOLCHAIN,
      GO_ENV.GOSUMDB,
      GO_ENV.GONOPROXY,
    ]);
    expect(result.clientConfiguration).toBe(true);
    expect(result.path.split(delimiter)).toContain(bin);
    expect(result.path.split(delimiter)).not.toContain(wtBin);
  });

  test("does not run a gopls in the worktree when nothing is bundled", async () => {
    const wt = await makeDir("go-wt-");
    const wtBin = join(wt, "bin");
    await mkdir(wtBin);
    const gopls = join(wtBin, "gopls");
    await writeExecutable(gopls, FAKE_GOPLS);
    const bin = await makeDir("go-bin-");
    await writeExecutable(join(bin, "go"), "#!/bin/sh\n");
    await restrictPath(wtBin, bin);
    // What resolveBundledBinary falls back to: the first on the plain PATH.
    manager = new TestGoLspManager(gopls);

    const client = fakeSocket();
    manager.createSession(client.ws, wt);
    expect((await client.untilClosed()).code).toBe(LSP_START_FAILED_CLOSE_CODE);
  });

  test("answers the gopls section with its settings and any other with an empty object", async () => {
    const wt = await makeDir("go-wt-");
    const bin = await makeDir("go-bin-");
    await writeExecutable(join(bin, "go"), "#!/bin/sh\n");
    const gopls = join(await makeDir("gopls-"), "gopls");
    await writeExecutable(gopls, FAKE_GOPLS);
    await restrictPath(bin);
    manager = new TestGoLspManager(gopls);

    const client = fakeSocket();
    manager.createSession(client.ws, wt);
    manager.handleMessage(client.ws, INITIALIZE);
    const report = await client.untilFrame((frame) => frame.method === "test/configuration");
    expect(report.params).toEqual([GOPLS_SETTINGS, {}]);
    const initialized = await client.untilFrame((frame) => frame.id === 1);
    expect(initialized.result).toMatchObject({
      capabilities: {
        codeActionProvider: { codeActionKinds: ["quickfix"] },
        executeCommandProvider: { commands: ["gopls.tidy"] },
      },
    });
  });
});

test("tells the client about a setup problem once per session", async () => {
  const wt = await makeDir("go-wt-");
  const bin = await makeDir("go-bin-");
  await writeExecutable(join(bin, "go"), "#!/bin/sh\n");
  const gopls = join(await makeDir("gopls-"), "gopls");
  await writeExecutable(gopls, FAKE_GOPLS);
  await restrictPath(bin);
  manager = new TestGoLspManager(gopls);

  const client = fakeSocket();
  manager.createSession(client.ws, wt);
  manager.handleMessage(client.ws, INITIALIZE);
  const warning = (await client.untilFrame((frame) => frame.method === "window/showMessage")) as {
    params: { type: number; message: string };
  };
  expect(warning.params.type).toBe(2);
  expect(warning.params.message).toContain("module of a/b");
  // The stand-in repeats the diagnostics after the first warning: only that one reaches the client.
  await client.untilFrame((frame) => frame.method === "test/repeated");
  expect(client.frames.filter((frame) => frame.method === "window/showMessage")).toHaveLength(1);
});

/** Stands in for `go`, reporting `version`. */
const fakeGo = (version: string) => `#!/bin/sh
echo '{"GOVERSION":"go${version}"}'
`;

describe("following the toolchain", () => {
  const TIMEOUT_MS = 30_000;

  async function startSession() {
    const wt = await makeDir("go-wt-");
    const bin = await makeDir("go-bin-");
    await writeExecutable(join(bin, "go"), fakeGo("1.27.3"));
    const gopls = join(await makeDir("gopls-"), "gopls");
    await writeExecutable(gopls, FAKE_GOPLS);
    await restrictPath(bin);
    manager = new TestGoLspManager(gopls);
    const client = fakeSocket();
    manager.createSession(client.ws, wt);
    manager.handleMessage(client.ws, INITIALIZE);
    await client.untilFrame((frame) => frame.id === 1);
    return { wt, bin, client };
  }

  test(
    "restarts gopls when the version of go changes",
    async () => {
      const { bin, client } = await startSession();
      const { code } = await repeatUntil(client.untilClosed(), () =>
        writeExecutable(join(bin, "go"), fakeGo("1.28.1")),
      );
      expect(code).toBe(LSP_RESTART_CLOSE_CODE);
    },
    TIMEOUT_MS,
  );

  test(
    "restarts gopls when a Go is chosen for the worktree, and runs it first on PATH",
    async () => {
      const { wt, client } = await startSession();
      const root = await makeDir("go-chosen-");
      await mkdir(join(root, "bin"));
      await writeExecutable(join(root, "bin", "go"), fakeGo("1.28.1"));
      setGoChoice(wt, join(root, "bin", "go"));
      refreshGoEnv(wt);
      const { code } = await client.untilClosed();
      expect(code).toBe(LSP_RESTART_CLOSE_CODE);
      manager?.destroySession(client.ws);

      const next = fakeSocket();
      manager?.createSession(next.ws, wt);
      manager?.handleMessage(next.ws, INITIALIZE);
      const frame = await next.untilFrame((candidate) => candidate.id === 1);
      expect(JSON.stringify(frame)).toContain(join(root, "bin"));
    },
    TIMEOUT_MS,
  );

  test(
    "restarts gopls when the user's own appears on the PATH, or is reinstalled",
    async () => {
      const { wt, bin, client } = await startSession();
      await writeExecutable(join(bin, "gopls"), FAKE_GOPLS);
      const { code } = await repeatUntil(client.untilClosed(), () =>
        writeExecutable(join(bin, "gopls"), FAKE_GOPLS),
      );
      expect(code).toBe(LSP_RESTART_CLOSE_CODE);
      manager?.destroySession(client.ws);

      const next = fakeSocket();
      manager?.createSession(next.ws, wt);
      manager?.handleMessage(next.ws, INITIALIZE);
      await next.untilFrame((frame) => frame.id === 1);
      const { code: reinstalled } = await repeatUntil(next.untilClosed(), async () => {
        await rm(join(bin, "gopls"));
        await writeExecutable(join(bin, "gopls"), FAKE_GOPLS);
      });
      expect(reinstalled).toBe(LSP_RESTART_CLOSE_CODE);
    },
    TIMEOUT_MS,
  );

  test(
    "restarts gopls when its go is refused, since gopls would find that one",
    async () => {
      const { wt, bin, client } = await startSession();
      await writeExecutable(join(wt, "go"), fakeGo("1.28.1"));
      const { code } = await repeatUntil(client.untilClosed(), async () => {
        await rm(join(bin, "go"), { force: true });
        await symlink(join(wt, "go"), join(bin, "go"));
      });
      expect(code).toBe(LSP_RESTART_CLOSE_CODE);
    },
    TIMEOUT_MS,
  );

  test(
    "keeps gopls running while go is gone, and restarts it for the go that comes back",
    async () => {
      const { wt, bin, client } = await startSession();
      const gone = new Promise<void>((resolve) => {
        const unsubscribe = subscribeGoEnv(wt, ({ env }) => {
          if (env) return;
          unsubscribe();
          resolve();
        });
      });
      await repeatUntil(gone, () => rm(join(bin, "go"), { force: true }));
      expect(client.closedWith()).toBeUndefined();
      const { code } = await repeatUntil(client.untilClosed(), () =>
        writeExecutable(join(bin, "go"), fakeGo("1.28.1")),
      );
      expect(code).toBe(LSP_RESTART_CLOSE_CODE);
    },
    TIMEOUT_MS,
  );
});

describe("which gopls runs", () => {
  async function runningGopls(prepare: (wt: string, bin: string) => Promise<void>) {
    const wt = await makeDir("go-wt-");
    const bin = await makeDir("go-bin-");
    await writeExecutable(join(bin, "go"), fakeGo("1.27.3"));
    const bundled = join(await makeDir("bundled-"), "gopls");
    await writeExecutable(bundled, FAKE_GOPLS);
    await restrictPath(bin);
    await prepare(wt, bin);
    manager = new TestGoLspManager(bundled);
    const client = fakeSocket();
    manager.createSession(client.ws, wt);
    manager.handleMessage(client.ws, INITIALIZE);
    const { result } = (await client.untilFrame((frame) => frame.id === 1)) as {
      result: { self: string };
    };
    return { self: result.self, bin, bundled };
  }

  test("the bundled one when the user has none", async () => {
    const { self, bundled } = await runningGopls(async () => {});
    expect(self).toBe(bundled);
  });

  test("the user's, without asking its version", async () => {
    const { self, bin } = await runningGopls(async (_wt, dir) => {
      await writeExecutable(join(dir, "gopls"), FAKE_GOPLS);
    });
    expect(self).toBe(join(bin, "gopls"));
  });

  test("the bundled one over a gopls in the worktree, however it is reached", async () => {
    const { self, bundled } = await runningGopls(async (wt, dir) => {
      await writeExecutable(join(wt, "gopls"), FAKE_GOPLS);
      await symlink(join(wt, "gopls"), join(dir, "gopls"));
    });
    expect(self).toBe(bundled);
  });

  test("the bundled one over a version manager's shim, which does not run", async () => {
    const log = join(await makeDir("gopls-log-"), "runs");
    await writeFile(log, "");
    const { self, bundled } = await runningGopls(async (_wt, dir) => {
      const shims = join(dir, "shims");
      await mkdir(shims);
      await writeExecutable(join(shims, "gopls"), `#!/bin/sh\necho run >> "${log}"\n`);
      await restrictPath(shims, dir);
    });
    expect(self).toBe(bundled);
    expect(await Bun.file(log).text()).toBe("");
  });
});

describe("goSetupProblem", () => {
  const diagnostics = (message: string) =>
    JSON.stringify({
      method: "textDocument/publishDiagnostics",
      params: { uri: "file:///a.go", diagnostics: [{ message }] },
    });

  test("tells which Go to install when go.mod needs a newer one", () => {
    const message =
      "packages.Load error: err: exit status 1: stderr: go: go.mod requires go >= 1.27.3 (running go 1.26.10; GOTOOLCHAIN=local)\n";
    for (const frame of [
      diagnostics(message),
      JSON.stringify({ method: "window/showMessage", params: { type: 4, message } }),
      // gopls's JSON encoder escapes `>`.
      JSON.stringify({ method: "window/showMessage", params: { type: 4, message } }).replaceAll(
        ">",
        "\\u003e",
      ),
    ]) {
      const problem = goSetupProblem(frame);
      expect(problem?.kind).toBe("newer-go");
      expect(problem?.message).toContain("needs Go 1.27.3, and the Go in use is 1.26.10");
    }
  });

  test("tells what to run when a module is not in the cache", () => {
    const problem = goSetupProblem(
      diagnostics(
        'could not import github.com/google/uuid (no required module provides package "github.com/google/uuid")',
      ),
    );
    expect(problem?.kind).toBe("missing-module");
    expect(problem?.message).toContain("github.com/google/uuid");
    expect(problem?.message).toContain("`go mod download`");
  });

  test("tells what to run when a load fails on a module lookup", () => {
    const problem = goSetupProblem(diagnostics("go: module lookup disabled by GOPROXY=off"));
    expect(problem?.kind).toBe("missing-module");
  });

  test("tells what to run when a command fails on a module lookup", () => {
    const problem = goSetupProblem(
      JSON.stringify({
        id: 7,
        error: {
          code: 0,
          message: "err: exit status 1: go: module lookup disabled by GOPROXY=off",
        },
      }),
    );
    expect(problem?.kind).toBe("command-needs-module");
    expect(problem?.message).toContain("`go mod download`");
  });

  test("ignores the same words anywhere but diagnostics and messages, and other diagnostics", () => {
    const hover = JSON.stringify({
      id: 1,
      result: { contents: "go.mod requires go >= 1.99 (running go 1.27; GOTOOLCHAIN=local)" },
    });
    expect(goSetupProblem(hover)).toBeNull();
    expect(goSetupProblem(diagnostics("undefined: x"))).toBeNull();
  });
});

describe("withoutHiddenActions", () => {
  test("removes the browse kinds and commands from the initialize response", () => {
    const body = JSON.stringify({
      id: 1,
      result: {
        capabilities: {
          codeActionProvider: {
            codeActionKinds: [
              "gopls.doc.features",
              "quickfix",
              "source.assembly",
              "source.doc",
              "source.freesymbols",
              "source.organizeImports",
              "source.splitPackage",
            ],
            resolveProvider: true,
          },
          executeCommandProvider: {
            commands: [
              "gopls.assembly",
              "gopls.doc",
              "gopls.free_symbols",
              "gopls.split_package",
              "gopls.tidy",
            ],
          },
        },
      },
    });
    expect(JSON.parse(withoutHiddenActions(body)).result.capabilities).toEqual({
      codeActionProvider: {
        codeActionKinds: ["quickfix", "source.organizeImports"],
        resolveProvider: true,
      },
      executeCommandProvider: { commands: ["gopls.tidy"] },
    });
  });

  test("removes the browse actions from a code action response", () => {
    const body = JSON.stringify({
      id: 2,
      result: [
        { title: "Browse documentation", kind: "source.doc" },
        { title: "Organize Imports", kind: "source.organizeImports" },
        { title: "Browse gopls feature documentation", kind: "gopls.doc.features" },
      ],
    });
    expect(JSON.parse(withoutHiddenActions(body)).result).toEqual([
      { title: "Organize Imports", kind: "source.organizeImports" },
    ]);
  });

  test("removes the quick fixes that look up modules online", () => {
    const body = JSON.stringify({
      id: 2,
      result: [
        { title: "go get package a/b", command: { command: "gopls.go_get_package" } },
        { title: "Check for upgrades", command: "gopls.check_upgrades" },
        { title: "Run go mod tidy", command: { command: "gopls.tidy" } },
      ],
    });
    expect(JSON.parse(withoutHiddenActions(body)).result).toEqual([
      { title: "Run go mod tidy", command: { command: "gopls.tidy" } },
    ]);
  });

  test("leaves every other frame as it is", () => {
    const frames = [
      `{"id":3,"result":[{"title":"Organize Imports","kind":"source.organizeImports"}]}`,
      `{"id":4,"result":[{"label":"Println","kind":3}]}`,
      `{"method":"textDocument/publishDiagnostics","params":{"uri":"file:///a.go","diagnostics":[]}}`,
      `{"id":5,"result":{"contents":{"kind":"markdown","value":"mentions \\"source.doc\\" in text"}}}`,
    ];
    for (const frame of frames) {
      expect(JSON.parse(withoutHiddenActions(frame))).toEqual(JSON.parse(frame));
    }
  });
});
