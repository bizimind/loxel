import { afterEach, describe, expect, test } from "bun:test";

import type { PythonEnv } from "@/api/python-env-model";
import type { TerminalState } from "@/api/ws-protocol";

import { TerminalManager } from "./terminal-manager";
import type { TerminalSink } from "./terminal-session";

const textDecoder = new TextDecoder();

function createRecordingSink() {
  const states: TerminalState[] = [];
  const output: Uint8Array[] = [];
  const sink: TerminalSink = {
    sendState: (state) => states.push(state),
    sendOutput: (_offset, data) => output.push(data),
    sendExit: () => {},
  };
  return { sink, states, outputText: () => output.map((o) => textDecoder.decode(o)).join("") };
}

async function until(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await Bun.sleep(10);
  }
}

const managers: TerminalManager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.destroyAll();
});

function createManager(
  initialCommandTtlMs?: number,
  pythonEnvFor: (worktreePath: string) => Promise<PythonEnv | null> = async () => null,
): TerminalManager {
  const manager = new TerminalManager(
    { isSequenceEnabled: () => false, onNotification: () => {}, onExit: () => {}, pythonEnvFor },
    initialCommandTtlMs,
  );
  managers.push(manager);
  return manager;
}

const attachOptions = { cols: 80, rows: 24, cwd: "/tmp" };

describe("TerminalManager initial commands", () => {
  // `/bin/sh -il` is what spawn() runs when SHELL points at it; a user's zsh would do the same.
  const originalShell = process.env.SHELL;
  afterEach(() => {
    process.env.SHELL = originalShell;
  });

  test("types the command into the shell on first spawn only", async () => {
    process.env.SHELL = "/bin/sh";
    const manager = createManager();
    const id = crypto.randomUUID();
    manager.setInitialCommand(id, "echo hello-from-$((40+2))");

    const first = createRecordingSink();
    await manager.attach(id, first.sink, attachOptions);
    await until(() => first.outputText().includes("hello-from-42"));

    // A respawn under the same ID (what a reload after a server restart does) gets a plain shell,
    // and the destroyed shell's late exit must not drop the new session from the manager.
    const firstSession = manager.get(id)!;
    manager.destroy(id);
    const second = createRecordingSink();
    await manager.attach(id, second.sink, attachOptions);
    const secondSession = manager.get(id);
    await firstSession.exited;
    expect(manager.get(id)).toBe(secondSession);
    manager.write(id, new TextEncoder().encode("echo done-$((1+1))\n"));
    await until(() => second.outputText().includes("done-2"));
    expect(second.outputText()).not.toContain("hello-from-42");
  });

  test("a command nobody attaches to in time is dropped", async () => {
    process.env.SHELL = "/bin/sh";
    const manager = createManager(50);
    const id = crypto.randomUUID();
    manager.setInitialCommand(id, "echo hello-from-$((40+2))");
    await Bun.sleep(100);

    const sink = createRecordingSink();
    await manager.attach(id, sink.sink, attachOptions);
    manager.write(id, new TextEncoder().encode("echo done-$((1+1))\n"));
    await until(() => sink.outputText().includes("done-2"));
    expect(sink.outputText()).not.toContain("hello-from-42");
  });

  test("the session keeps the panel's worktree apart from the shell's cwd", async () => {
    process.env.SHELL = "/bin/sh";
    const manager = createManager();
    const id = crypto.randomUUID();
    await manager.attach(id, createRecordingSink().sink, { ...attachOptions, worktreePath: "/" });
    expect(manager.get(id)?.cwd).toBe("/tmp");
    expect(manager.get(id)?.worktreePath).toBe("/");

    const plain = crypto.randomUUID();
    await manager.attach(plain, createRecordingSink().sink, attachOptions);
    expect(manager.get(plain)?.worktreePath).toBe("/tmp");
  });

  test("a shell spawned with no client runs its command, and a later attach binds to it", async () => {
    process.env.SHELL = "/bin/sh";
    const manager = createManager();
    const id = crypto.randomUUID();
    manager.setInitialCommand(id, "echo hello-from-$((40+2))");

    await manager.ensureSpawned(id, attachOptions);
    const session = manager.get(id);
    await manager.ensureSpawned(id, attachOptions);
    expect(manager.get(id)).toBe(session);
    expect(session?.attached).toBe(false);

    const sink = createRecordingSink();
    await manager.attach(id, sink.sink, attachOptions);
    const shown = () => sink.states.map((s) => s.snapshot ?? "").join("") + sink.outputText();
    await until(() => shown().includes("hello-from-42"));
    expect(manager.get(id)).toBe(session);
  });

  test("shells don't inherit a coding agent's variables from the server", async () => {
    process.env.SHELL = "/bin/sh";
    const originalMarker = process.env.CLAUDECODE;
    process.env.CLAUDECODE = "1";
    try {
      const manager = createManager();
      const id = crypto.randomUUID();
      manager.setInitialCommand(id, "echo agent-marker-[${CLAUDECODE-unset}]");
      const sink = createRecordingSink();
      await manager.attach(id, sink.sink, attachOptions);
      await until(() => sink.outputText().includes("agent-marker-[unset]"));
    } finally {
      if (originalMarker === undefined) delete process.env.CLAUDECODE;
      else process.env.CLAUDECODE = originalMarker;
    }
  });

  test("a command can be cleared before the panel attaches", async () => {
    process.env.SHELL = "/bin/sh";
    const manager = createManager();
    const id = crypto.randomUUID();
    manager.setInitialCommand(id, "echo hello-from-$((40+2))");
    manager.clearInitialCommand(id);

    const sink = createRecordingSink();
    await manager.attach(id, sink.sink, attachOptions);
    manager.write(id, new TextEncoder().encode("echo done-$((1+1))\n"));
    await until(() => sink.outputText().includes("done-2"));
    expect(sink.outputText()).not.toContain("hello-from-42");
  });
});

describe("TerminalManager Python environments", () => {
  const originalShell = process.env.SHELL;
  afterEach(() => {
    process.env.SHELL = originalShell;
  });

  test("activates the worktree's environment in the shell", async () => {
    process.env.SHELL = "/bin/sh";
    const envPath = "/tmp/loxel-test-env";
    const asked: string[] = [];
    const manager = createManager(undefined, async (worktreePath) => {
      asked.push(worktreePath);
      return { source: "pixi", pythonPath: `${envPath}/bin/python`, envPath };
    });
    const id = crypto.randomUUID();
    // Only zsh keeps the entry first (macOS /etc/profile reorders PATH for sh), so check presence.
    manager.setInitialCommand(
      id,
      `case ":$PATH:" in *:${envPath}/bin:*) echo env-on-$((1+1));; esac`,
    );
    const sink = createRecordingSink();
    await manager.attach(id, sink.sink, { ...attachOptions, worktreePath: "/" });
    await until(() => sink.outputText().includes("env-on-2"));
    expect(asked).toEqual(["/"]);

    // Turned off in settings: the environment is not even resolved.
    const off = crypto.randomUUID();
    await manager.attach(off, createRecordingSink().sink, {
      ...attachOptions,
      activatePythonEnv: false,
    });
    expect(asked).toEqual(["/"]);
  });

  test("concurrent starts share one shell, and one closed while starting never runs", async () => {
    process.env.SHELL = "/bin/sh";
    let release = () => {};
    const gate = new Promise<null>((resolve) => {
      release = () => resolve(null);
    });
    const manager = createManager(undefined, () => gate);

    const id = crypto.randomUUID();
    const first = manager.attach(id, createRecordingSink().sink, attachOptions);
    const second = manager.ensureSpawned(id, attachOptions);
    const closed = crypto.randomUUID();
    const neverStarted = manager.ensureSpawned(closed, attachOptions);
    manager.destroy(closed);

    release();
    await Promise.all([first, second, neverStarted]);
    expect(manager.get(id)?.attached).toBe(true);
    expect(manager.get(closed)).toBeUndefined();
  });
});
