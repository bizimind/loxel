import { afterEach, describe, expect, test } from "bun:test";

import { createNoopLogger } from "@bizimind/logger";

import type { TerminalState } from "@/api/terminal-stream";
import { BIN_OUTPUT_HEADER_SIZE, encodeOutputFrame } from "@/api/terminal-stream";
import type {
  ForegroundProcesses,
  TerminalAttachRequest,
  TerminalHost,
  TerminalHostEvent,
  TerminalSessionInfo,
  TerminalSpawnRequest,
} from "@/terminal-host";
import { InProcessTerminalHost } from "@/terminal-host";
import { until } from "@/test/until";

import type { TerminalManagerHooks, TerminalSink } from "./terminal-manager";
import { TerminalManager } from "./terminal-manager";
import type { ToolchainEnvContributor } from "./toolchain-env-contributor";

const textDecoder = new TextDecoder();

function createRecordingSink() {
  const states: TerminalState[] = [];
  const output: Uint8Array[] = [];
  const exits: number[] = [];
  const sink: TerminalSink = {
    sendState: (state) => states.push(state),
    sendOutput: ({ data }) => output.push(data),
    sendExit: (exitCode) => exits.push(exitCode),
  };
  return {
    sink,
    states,
    exits,
    outputText: () => output.map((o) => textDecoder.decode(o)).join(""),
  };
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
  return { name: "Test", resolveForTerminal, ...overrides };
}

function createHost(): InProcessTerminalHost {
  return new InProcessTerminalHost({ log: createNoopLogger() });
}

function createManager(
  toolchainEnvs: readonly ToolchainEnvContributor[] = [],
  host: TerminalHost = createHost(),
  hooks: Partial<TerminalManagerHooks> = {},
): TerminalManager {
  const manager = new TerminalManager(host, {
    isSequenceEnabled: () => false,
    onNotification: () => {},
    onExit: () => {},
    toolchainEnvs,
    ...hooks,
  });
  managers.push(manager);
  return manager;
}

/** True once the process is gone, reaped included, which is when its exit has been handled. */
function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
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
    const host = createHost();
    const manager = createManager([], host);
    const id = crypto.randomUUID();

    const first = createRecordingSink();
    await manager.attach(id, first.sink, {
      ...attachOptions,
      command: "echo hello-from-$((40+2))",
    });
    await until(() => first.outputText().includes("hello-from-42"));

    // A respawn under the same ID (what a reload after a server restart does) gets a plain shell,
    // and the destroyed shell's late exit must not drop the new session from the manager.
    const [firstSession] = await host.list();
    manager.destroy(id);
    const second = createRecordingSink();
    await manager.attach(id, second.sink, attachOptions);
    await until(() => processGone(firstSession!.pid));
    expect(manager.get(id)).toBeDefined();
    expect((await host.list()).map((s) => s.epoch)).not.toContain(firstSession!.epoch);
    manager.write(id, new TextEncoder().encode("echo done-$((1+1))\n"));
    await until(() => second.outputText().includes("done-2"));
    expect(second.outputText()).not.toContain("hello-from-42");
  });

  test("the session keeps the panel's worktree apart from the shell's cwd", async () => {
    process.env.SHELL = "/bin/sh";
    const host = createHost();
    const manager = createManager([], host);
    const id = crypto.randomUUID();
    await manager.attach(id, createRecordingSink().sink, {
      ...attachOptions,
      worktreePath: "/",
      windowId: "w1",
    });
    const meta = { worktreePath: "/", cwd: "/tmp", windowId: "w1" };
    expect(manager.get(id)?.meta).toEqual(meta);
    // The host holds the same, for a server that has to find its sessions again.
    expect((await host.list()).map((s) => s.meta)).toEqual([meta]);

    // A Home terminal belongs to no worktree, wherever its shell starts.
    const home = crypto.randomUUID();
    await manager.attach(home, createRecordingSink().sink, attachOptions);
    expect(manager.get(home)?.meta).toEqual({ worktreePath: null, cwd: "/tmp" });
  });

  test("a shell spawned with no client runs its command, and a later attach binds to it", async () => {
    process.env.SHELL = "/bin/sh";
    const host = createHost();
    const manager = createManager([], host);
    const id = crypto.randomUUID();

    await manager.ensureSpawned(id, { ...attachOptions, command: "echo hello-from-$((40+2))" });
    const spawned = await host.list();
    await manager.ensureSpawned(id, attachOptions);
    expect((await host.list()).map((s) => s.epoch)).toEqual([spawned[0]!.epoch]);
    expect(manager.get(id)?.attached).toBe(false);

    const sink = createRecordingSink();
    await manager.attach(id, sink.sink, attachOptions);
    const shown = () => sink.states.map((s) => s.snapshot ?? "").join("") + sink.outputText();
    await until(() => shown().includes("hello-from-42"));
    expect(sink.states[0]?.epoch).toBe(spawned[0]!.epoch);
    expect(manager.get(id)?.attached).toBe(true);
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

  test("shells don't inherit the server's own Loxel terminal, so a Home shell has no worktree", async () => {
    process.env.SHELL = "/bin/sh";
    const original = { wt: process.env.LOXEL_WORKTREE, win: process.env.LOXEL_WINDOW_ID };
    process.env.LOXEL_WORKTREE = "/some/worktree";
    process.env.LOXEL_WINDOW_ID = "server-window";
    try {
      const manager = createManager();
      const id = crypto.randomUUID();
      const sink = createRecordingSink();
      await manager.attach(id, sink.sink, {
        ...attachOptions,
        command: "echo loxel-marker-[${LOXEL_WORKTREE-unset}:${LOXEL_WINDOW_ID-unset}]",
      });
      await until(() => sink.outputText().includes("loxel-marker-[unset:unset]"));
    } finally {
      for (const [name, value] of [
        ["LOXEL_WORKTREE", original.wt],
        ["LOXEL_WINDOW_ID", original.win],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
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
    const host = createHost();
    return { manager: createManager([contributor(() => gate)], host), host, release };
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
    const { manager, host, release } = gatedManager();
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
    expect((await host.list()).map(({ cols, rows }) => ({ cols, rows }))).toEqual([
      { cols: 100, rows: 30 },
    ]);
  });
});

describe("ending a removed worktree's sessions", () => {
  const originalShell = process.env.SHELL;
  afterEach(() => {
    process.env.SHELL = originalShell;
  });

  const inWorktree = (worktreePath: string) => ({ cols: 80, rows: 24, cwd: "/tmp", worktreePath });

  const end = (manager: TerminalManager, worktreePath: string, delayMs = 0) => {
    const ended: string[] = [];
    manager.endWorktreeSessions(worktreePath, delayMs, (id) => ended.push(id));
    return ended;
  };

  test("ends the worktree's sessions and no other's", async () => {
    process.env.SHELL = "/bin/sh";
    const manager = createManager();
    const [a, b, other] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    await manager.ensureSpawned(a, inWorktree("/wt/a"));
    await manager.ensureSpawned(b, inWorktree("/wt/a"));
    await manager.ensureSpawned(other, inWorktree("/wt/a-other"));

    expect(end(manager, "/wt/a").toSorted()).toEqual([a, b].toSorted());

    expect(manager.get(a)).toBeUndefined();
    expect(manager.get(b)).toBeUndefined();
    expect(manager.get(other)).toBeDefined();
    expect(end(manager, "/wt/a")).toEqual([]);
  });

  test("with a delay, ends them later, and leaves a new session at the same path", async () => {
    process.env.SHELL = "/bin/sh";
    const manager = createManager();
    const [old, closed, recreated] = [
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
    ];
    await manager.ensureSpawned(old, inWorktree("/wt/a"));
    await manager.ensureSpawned(closed, inWorktree("/wt/a"));

    const ended = end(manager, "/wt/a", 50);
    expect(ended).toEqual([]);
    expect(manager.get(old)).toBeDefined();

    manager.destroy(closed);
    await manager.ensureSpawned(recreated, inWorktree("/wt/a"));
    await until(() => manager.get(old) === undefined);

    expect(ended).toEqual([old]);
    expect(manager.get(recreated)).toBeDefined();
  });

  test("a shell still waiting for its environment never starts", async () => {
    process.env.SHELL = "/bin/sh";
    let release = (): void => {};
    const blocked = new Promise<null>((resolve) => {
      release = () => resolve(null);
    });
    const manager = createManager([{ name: "blocked", resolveForTerminal: () => blocked }]);
    const id = crypto.randomUUID();
    const started = manager.ensureSpawned(id, inWorktree("/wt/a"));

    expect(end(manager, "/wt/a", 60_000)).toEqual([id]);
    release();
    await started;

    expect(manager.get(id)).toBeUndefined();
  });

  test("a shell still starting when its worktree moves belongs to the new path", async () => {
    process.env.SHELL = "/bin/sh";
    let release = (): void => {};
    const blocked = new Promise<null>((resolve) => {
      release = () => resolve(null);
    });
    const manager = createManager([{ name: "blocked", resolveForTerminal: () => blocked }]);
    const id = crypto.randomUUID();
    const started = manager.ensureSpawned(id, inWorktree("/wt/before"));

    manager.retargetWorktree("/wt/before", "/wt/after");
    release();
    await started;

    expect(manager.get(id)?.meta.worktreePath).toBe("/wt/after");
  });

  test("a moved worktree's sessions are found at the new path", async () => {
    process.env.SHELL = "/bin/sh";
    const host = createHost();
    const manager = createManager([], host);
    const id = crypto.randomUUID();
    await manager.ensureSpawned(id, inWorktree("/wt/before"));

    manager.retargetWorktree("/wt/before", "/wt/after");
    expect((await host.list()).map((s) => s.meta)).toEqual([
      { worktreePath: "/wt/after", cwd: "/tmp" },
    ]);

    expect(end(manager, "/wt/before")).toEqual([]);
    expect(end(manager, "/wt/after")).toEqual([id]);
  });
});

describe("TerminalManager host events", () => {
  const originalShell = process.env.SHELL;
  afterEach(() => {
    process.env.SHELL = originalShell;
  });

  test("notifications pass the server's sequence settings and are filed under the worktree", async () => {
    process.env.SHELL = "/bin/sh";
    const notifications: unknown[] = [];
    const manager = createManager([], createHost(), {
      isSequenceEnabled: (sequence) => sequence !== "osc9",
      onNotification: (id, meta, payload) => notifications.push({ id, meta, payload }),
    });
    const id = crypto.randomUUID();
    // OSC 9 comes first in the stream, so it has been dropped by the time OSC 777 is reported.
    await manager.ensureSpawned(id, {
      ...attachOptions,
      worktreePath: "/wt/a",
      command: String.raw`printf '\033]9;nine\007\033]777;notify;T;B\007'`,
    });
    await until(() => notifications.length > 0);
    expect(notifications).toEqual([
      {
        id,
        meta: { worktreePath: "/wt/a", cwd: "/tmp" },
        payload: { title: "T", body: "B", urgency: "normal" },
      },
    ]);
  });

  test("an exit reaches the attached client and the hook, and ends the session", async () => {
    process.env.SHELL = "/bin/sh";
    const exits: unknown[] = [];
    const manager = createManager([], createHost(), {
      onExit: (id, exitCode) => exits.push({ id, exitCode }),
    });
    const id = crypto.randomUUID();
    const sink = createRecordingSink();
    await manager.attach(id, sink.sink, { ...attachOptions, command: "exit 3" });
    await until(() => exits.length === 1);
    expect(exits).toEqual([{ id, exitCode: 3 }]);
    expect(sink.exits).toEqual([3]);
    expect(manager.get(id)).toBeUndefined();
  });
});

/**
 * A host whose events the test sends, for the orderings a host across a socket can produce: events
 * already on their way when the manager sends a command that makes them stale.
 */
class FakeTerminalHost implements TerminalHost {
  readonly spawns: TerminalSpawnRequest[] = [];
  readonly attaches: TerminalAttachRequest[] = [];
  readonly destroyed: string[] = [];
  /** When set, spawns wait for `answerSpawns()` instead of succeeding at once. */
  holdSpawns = false;
  private held: { resolve: () => void; reject: (err: Error) => void }[] = [];
  private listener: (event: TerminalHostEvent) => void = () => {};

  spawn(request: TerminalSpawnRequest): Promise<TerminalSessionInfo> {
    this.spawns.push(request);
    const { id, epoch, cols, rows, meta } = request;
    const info = { id, epoch, offset: 0, pid: 1, cols, rows, meta };
    if (!this.holdSpawns) return Promise.resolve(info);
    return new Promise((resolve, reject) => {
      this.held.push({ resolve: () => resolve(info), reject });
    });
  }
  /** Answer every held spawn, with `error` if given. */
  answerSpawns(error?: Error): void {
    for (const { resolve, reject } of this.held.splice(0)) {
      if (error) reject(error);
      else resolve();
    }
  }
  list(): Promise<TerminalSessionInfo[]> {
    return Promise.resolve([]);
  }
  attach(request: TerminalAttachRequest): Promise<void> {
    this.attaches.push(request);
    return Promise.resolve();
  }
  detach(): void {}
  write(): void {}
  resize(): void {}
  setScrollback(): void {}
  ack(): void {}
  destroy(id: string): void {
    this.destroyed.push(id);
  }
  foregroundProcesses(): Promise<ForegroundProcesses> {
    return Promise.resolve({});
  }
  setMeta(): void {}
  onEvent(listener: (event: TerminalHostEvent) => void): () => void {
    this.listener = listener;
    return () => {};
  }
  emit(event: TerminalHostEvent): void {
    this.listener(event);
  }
}

describe("TerminalManager with events in flight", () => {
  const originalShell = process.env.SHELL;
  afterEach(() => {
    process.env.SHELL = originalShell;
  });

  const state = (id: string, epoch: string, offset: number): TerminalState => ({
    id,
    epoch,
    mode: "snapshot",
    offset,
    snapshot: "",
    cols: 80,
    rows: 24,
  });
  const output = (id: string, offset: number): TerminalHostEvent => {
    const frame = encodeOutputFrame(id, offset, new Uint8Array([0x61]));
    return { type: "output", id, offset, data: frame.subarray(BIN_OUTPUT_HEADER_SIZE), frame };
  };

  test("a client gets only its own attach's states, and output only after its state", async () => {
    const host = new FakeTerminalHost();
    const manager = createManager([], host);
    const id = crypto.randomUUID();
    const first = createRecordingSink();
    const second = createRecordingSink();
    await manager.attach(id, first.sink, attachOptions);
    await manager.attach(id, second.sink, attachOptions);
    const [older, newer] = host.attaches.map((a) => a.attachment);
    expect(newer).not.toBe(older);

    // Still on its way from before the second attach: the first client's resync and output.
    host.emit({ type: "state", attachment: older!, state: state(id, "epoch-1", 0) });
    host.emit(output(id, 0));
    expect(first.states).toEqual([]);
    expect(second.states).toEqual([]);
    expect(second.outputText()).toBe("");

    host.emit({ type: "state", attachment: newer!, state: state(id, "epoch-1", 1) });
    host.emit(output(id, 1));
    expect(second.states.map((s) => s.offset)).toEqual([1]);
    expect(second.outputText()).toBe("a");
    expect(first.outputText()).toBe("");
  });

  test("events from an earlier spawn under the same ID do not touch its replacement", async () => {
    const host = new FakeTerminalHost();
    const notifications: string[] = [];
    const exits: string[] = [];
    const manager = createManager([], host, {
      isSequenceEnabled: () => true,
      onNotification: (id) => notifications.push(id),
      onExit: (id) => exits.push(id),
    });
    const id = crypto.randomUUID();
    await manager.ensureSpawned(id, attachOptions);
    manager.destroy(id);
    await manager.ensureSpawned(id, attachOptions);
    const [earlier, current] = host.spawns.map((spawn) => spawn.epoch);
    expect(current).not.toBe(earlier);

    host.emit({ type: "osc", id, epoch: earlier!, code: 9, data: "stale" });
    host.emit({ type: "exit", id, epoch: earlier!, exitCode: 0 });
    expect(notifications).toEqual([]);
    expect(exits).toEqual([]);
    expect(manager.get(id)).toBeDefined();

    host.emit({ type: "osc", id, epoch: current!, code: 9, data: "current" });
    host.emit({ type: "exit", id, epoch: current!, exitCode: 0 });
    expect(notifications).toEqual([id]);
    expect(exits).toEqual([id]);
    expect(manager.get(id)).toBeUndefined();
  });

  /** Attach to a new terminal `id` and resolve once the host has been asked to spawn it. */
  async function attachWhileSpawning(host: FakeTerminalHost, manager: TerminalManager, id: string) {
    host.holdSpawns = true;
    const first = createRecordingSink();
    const attached = manager.attach(id, first.sink, attachOptions);
    await until(() => host.spawns.length === 1);
    return { first, attached };
  }

  test("an exit that arrives before the spawn's answer ends the session", async () => {
    const host = new FakeTerminalHost();
    const exits: string[] = [];
    const manager = createManager([], host, { onExit: (id) => exits.push(id) });
    const id = crypto.randomUUID();
    const { first, attached } = await attachWhileSpawning(host, manager, id);

    host.emit({ type: "exit", id, epoch: host.spawns[0]!.epoch, exitCode: 1 });
    host.answerSpawns();
    await attached;
    expect(exits).toEqual([id]);
    expect(first.exits).toEqual([1]);
    expect(manager.get(id)).toBeUndefined();
    expect(host.attaches).toEqual([]);
  });

  test("a client that detaches before the spawn's answer is not bound", async () => {
    const host = new FakeTerminalHost();
    const manager = createManager([], host);
    const id = crypto.randomUUID();
    const { attached } = await attachWhileSpawning(host, manager, id);
    expect(manager.hasOrphanSessions()).toBe(false);

    manager.detach(id);
    expect(manager.hasOrphanSessions()).toBe(true);
    host.answerSpawns();
    await attached;
    expect(host.attaches).toEqual([]);
    expect(manager.get(id)?.attached).toBe(false);
  });

  test("of two attaches before the spawn's answer, the later one gets the session", async () => {
    const host = new FakeTerminalHost();
    const manager = createManager([], host);
    const id = crypto.randomUUID();
    const { first, attached } = await attachWhileSpawning(host, manager, id);
    const second = createRecordingSink();
    const secondAttached = manager.attach(id, second.sink, attachOptions);

    host.answerSpawns();
    await Promise.all([attached, secondAttached]);
    expect(host.attaches).toHaveLength(1);
    const { attachment } = host.attaches[0]!;
    host.emit({ type: "state", attachment, state: state(id, host.spawns[0]!.epoch, 0) });
    expect(second.states).toHaveLength(1);
    expect(first.states).toEqual([]);
  });

  test("a spawn the host refuses fails every attach waiting on it", async () => {
    const host = new FakeTerminalHost();
    const manager = createManager([], host);
    const id = crypto.randomUUID();
    const { attached } = await attachWhileSpawning(host, manager, id);
    const secondAttached = manager.attach(id, createRecordingSink().sink, attachOptions);

    host.answerSpawns(new Error("no pty"));
    const results = await Promise.allSettled([attached, secondAttached]);
    expect(results.map((r) => r.status === "rejected" && String(r.reason))).toEqual([
      "Error: no pty",
      "Error: no pty",
    ]);
    expect(manager.get(id)).toBeUndefined();
  });

  test("the spawn request carries the shell, settings, meta and everything typed ahead", async () => {
    process.env.SHELL = "/bin/sh";
    let release = () => {};
    const gate = new Promise<null>((resolve) => {
      release = () => resolve(null);
    });
    const host = new FakeTerminalHost();
    const manager = createManager([contributor(() => gate)], host);
    const id = crypto.randomUUID();
    const started = manager.ensureSpawned(id, {
      ...attachOptions,
      worktreePath: "/wt/a",
      windowId: "w1",
      command: "echo hi",
    });
    manager.write(id, new TextEncoder().encode("typed"));
    manager.resize(id, 100, 30);
    release();
    await started;

    const [spawned] = host.spawns;
    expect(spawned).toMatchObject({
      id,
      argv: ["/bin/sh", "-il"],
      cwd: "/tmp",
      cols: 100,
      rows: 30,
      scrollbackLines: 50_000,
      meta: { worktreePath: "/wt/a", cwd: "/tmp", windowId: "w1" },
    });
    expect(textDecoder.decode(spawned!.input)).toBe("echo hi\ntyped");
    expect(Object.values(spawned!.env).every((value) => typeof value === "string")).toBe(true);
  });
});

describe("TerminalManager adopting sessions found running", () => {
  const info = (meta: TerminalSessionInfo["meta"]): TerminalSessionInfo => ({
    id: crypto.randomUUID(),
    epoch: "epoch-1",
    offset: 120,
    pid: 1,
    cols: 80,
    rows: 24,
    meta,
  });

  test("an adopted session is an orphan until a client attaches, resuming where it was", async () => {
    const host = new FakeTerminalHost();
    const manager = createManager([], host);
    const running = info({ worktreePath: "/wt/a", cwd: "/wt/a/sub", windowId: "w1" });
    manager.adopt([running]);

    expect(manager.get(running.id)).toEqual({
      meta: { worktreePath: "/wt/a", cwd: "/wt/a/sub", windowId: "w1" },
      attached: false,
    });
    expect(manager.hasOrphanSessions()).toBe(true);

    const client = createRecordingSink();
    await manager.attach(running.id, client.sink, {
      ...attachOptions,
      sinceEpoch: "epoch-1",
      sinceOffset: 100,
    });
    // Attached to the running session, not spawned anew.
    expect(host.spawns).toEqual([]);
    expect(host.attaches).toEqual([
      expect.objectContaining({ id: running.id, since: { epoch: "epoch-1", offset: 100 } }),
    ]);
    expect(manager.hasOrphanSessions()).toBe(false);
  });

  test("a Home terminal, which has no worktree, is adopted like any other", () => {
    const host = new FakeTerminalHost();
    const manager = createManager([], host);
    const home = info({ worktreePath: null, cwd: "/Users/me" });
    manager.adopt([home]);
    expect(host.destroyed).toEqual([]);
    expect(manager.get(home.id)?.meta).toEqual({ worktreePath: null, cwd: "/Users/me" });
  });

  test("a session whose meta it cannot read is ended", () => {
    const host = new FakeTerminalHost();
    const manager = createManager([], host);
    const unreadable = info({ somethingElse: true });
    manager.adopt([unreadable]);
    expect(host.destroyed).toEqual([unreadable.id]);
    expect(manager.get(unreadable.id)).toBeUndefined();
  });
});
