import { afterEach, describe, expect, test } from "bun:test";

import type { TerminalState } from "@/api/ws-protocol";
import { until } from "@/test/until";

import { TerminalManager } from "./terminal-manager";
import type { TerminalSink } from "./terminal-session";
import type { ToolchainEnvContributor } from "./toolchain-env-contributor";

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

const managers: TerminalManager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.destroyAll();
});

/** A contributor to terminals only, with the given resolution. */
function contributor(
  resolveForTerminal: ToolchainEnvContributor["resolveForTerminal"],
  overrides: Partial<ToolchainEnvContributor> = {},
): ToolchainEnvContributor {
  return {
    name: "Test",
    resolveForTerminal,
    resolveForAgent: async () => null,
    subscribeForAgent: () => () => {},
    ...overrides,
  };
}

function createManager(toolchainEnvs: readonly ToolchainEnvContributor[] = []): TerminalManager {
  const manager = new TerminalManager({
    isSequenceEnabled: () => false,
    onNotification: () => {},
    onExit: () => {},
    toolchainEnvs,
  });
  managers.push(manager);
  return manager;
}

const attachOptions = { cols: 80, rows: 24, cwd: "/tmp" };

describe("TerminalManager commands", () => {
  // `/bin/sh -il` is what spawn() runs when SHELL points at it; a user's zsh would do the same.
  const originalShell = process.env.SHELL;
  afterEach(() => {
    process.env.SHELL = originalShell;
  });

  test("types the command into the shell it spawns, and a respawn gets a plain shell", async () => {
    process.env.SHELL = "/bin/sh";
    const manager = createManager();
    const id = crypto.randomUUID();

    const first = createRecordingSink();
    await manager.attach(id, first.sink, {
      ...attachOptions,
      command: "echo hello-from-$((40+2))",
    });
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

    await manager.ensureSpawned(id, { ...attachOptions, command: "echo hello-from-$((40+2))" });
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
      const sink = createRecordingSink();
      await manager.attach(id, sink.sink, {
        ...attachOptions,
        command: "echo agent-marker-[${CLAUDECODE-unset}]",
      });
      await until(() => sink.outputText().includes("agent-marker-[unset]"));
    } finally {
      if (originalMarker === undefined) delete process.env.CLAUDECODE;
      else process.env.CLAUDECODE = originalMarker;
    }
  });
});

describe("TerminalManager toolchain environments", () => {
  const originalShell = process.env.SHELL;
  afterEach(() => {
    process.env.SHELL = originalShell;
  });

  test("applies the worktree's toolchains to the shell, in list order, past one that fails", async () => {
    process.env.SHELL = "/bin/sh";
    const asked: string[] = [];
    const manager = createManager([
      contributor(async (worktreePath) => {
        asked.push(worktreePath);
        return (env) => {
          env.TOOLCHAIN_ORDER = "first";
        };
      }),
      contributor(async () => {
        throw new Error("no toolchain");
      }),
      contributor(async () => (env) => {
        env.TOOLCHAIN_ORDER = `${env.TOOLCHAIN_ORDER}-second`;
      }),
    ]);
    const id = crypto.randomUUID();
    const sink = createRecordingSink();
    await manager.attach(id, sink.sink, {
      ...attachOptions,
      worktreePath: "/",
      command: "echo order-[$TOOLCHAIN_ORDER]",
    });
    await until(() => sink.outputText().includes("order-[first-second]"));
    expect(asked).toEqual(["/"]);
  });

  test("a toolchain that never answers does not hold up the shell or the others", async () => {
    process.env.SHELL = "/bin/sh";
    const manager = createManager([
      contributor(() => new Promise(() => {})),
      contributor(async () => (env) => {
        env.TOOLCHAIN_ANSWERED = "yes";
      }),
    ]);
    const sink = createRecordingSink();
    await manager.attach(crypto.randomUUID(), sink.sink, {
      ...attachOptions,
      command: "echo answered-[$TOOLCHAIN_ANSWERED]",
    });
    await until(() => sink.outputText().includes("answered-[yes]"));
  }, 15_000);

  test("a toolchain the terminal's settings turn off is not even resolved", async () => {
    process.env.SHELL = "/bin/sh";
    const asked: string[] = [];
    const resolve = async (worktreePath: string) => {
      asked.push(worktreePath);
      return null;
    };
    const manager = createManager([
      contributor(resolve, { enabledInTerminal: (s) => s.activatePythonEnv !== false }),
    ]);
    await manager.attach(crypto.randomUUID(), createRecordingSink().sink, {
      ...attachOptions,
      activatePythonEnv: false,
    });
    expect(asked).toEqual([]);
  });

  test("starts without a toolchain whose PATH entry the shell would interpret", async () => {
    process.env.SHELL = "/bin/sh";
    const manager = createManager([
      contributor(async () => (env) => {
        env.PATH = `/wt-$name/bin:${env.PATH}`;
        env.LOXEL_TEST_TOOLCHAIN = "applied";
      }),
    ]);
    const { sink, outputText } = createRecordingSink();
    await manager.attach(crypto.randomUUID(), sink, {
      ...attachOptions,
      command: 'echo "toolchain-[$LOXEL_TEST_TOOLCHAIN]"',
    });
    await until(() => outputText().includes("toolchain-[]"));
  });

  test("concurrent starts share one shell, and one closed while starting never runs", async () => {
    process.env.SHELL = "/bin/sh";
    let release = () => {};
    const gate = new Promise<null>((resolve) => {
      release = () => resolve(null);
    });
    const manager = createManager([contributor(() => gate)]);

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

  /** A manager whose environment lookup waits until `release()`. */
  function gatedManager() {
    let release = () => {};
    const gate = new Promise<null>((resolve) => {
      release = () => resolve(null);
    });
    return { manager: createManager([contributor(() => gate)]), release };
  }

  test("a panel attaching while a command's shell starts gets that shell, command included", async () => {
    process.env.SHELL = "/bin/sh";
    const { manager, release } = gatedManager();
    const id = crypto.randomUUID();
    const spawned = manager.ensureSpawned(id, { ...attachOptions, command: "echo first-$((1+1))" });
    const sink = createRecordingSink();
    const attached = manager.attach(id, sink.sink, attachOptions);
    release();
    await Promise.all([spawned, attached]);
    await until(() => sink.outputText().includes("first-2"));
    expect(manager.get(id)?.attached).toBe(true);
  });

  test("a client that detaches while the shell starts is not bound to it", async () => {
    process.env.SHELL = "/bin/sh";
    const { manager, release } = gatedManager();
    const id = crypto.randomUUID();
    const attached = manager.attach(id, createRecordingSink().sink, attachOptions);
    manager.detach(id);
    release();
    await attached;
    expect(manager.get(id)?.attached).toBe(false);
    expect(manager.hasOrphanSessions()).toBe(true);
  });

  test("input, a resize and the command sent while the shell starts all reach it", async () => {
    process.env.SHELL = "/bin/sh";
    const { manager, release } = gatedManager();
    const id = crypto.randomUUID();
    const sink = createRecordingSink();
    const attached = manager.attach(id, sink.sink, {
      ...attachOptions,
      command: "echo first-$((1+1))",
    });
    manager.write(id, new TextEncoder().encode("echo second-$((2+2))\n"));
    manager.resize(id, 100, 30);
    release();
    await attached;
    await until(() => sink.outputText().includes("second-4"));
    expect(sink.outputText().indexOf("first-2")).toBeLessThan(
      sink.outputText().indexOf("second-4"),
    );
    expect(manager.get(id)?.cols).toBe(100);
  });
});
