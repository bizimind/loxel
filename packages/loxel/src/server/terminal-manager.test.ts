import { afterEach, describe, expect, test } from "bun:test";

import { createNoopLogger } from "@/api/log-entry-model";
import type { TerminalState } from "@/api/terminal-stream";
import { BIN_OUTPUT_HEADER_SIZE, encodeOutputFrame } from "@/api/terminal-stream";
import type { TerminalEnd, TerminalNotice } from "@/api/ws-protocol";
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

import type { TerminalSink, TerminalSize } from "./terminal-fanout";
import type { TerminalManagerHooks } from "./terminal-manager";
import { TerminalManager } from "./terminal-manager";
import type { ToolchainEnvContributor } from "./toolchain-env-contributor";

const textDecoder = new TextDecoder();

function createRecordingSink() {
  const states: TerminalState[] = [];
  const output: Uint8Array[] = [];
  const exits: TerminalEnd[] = [];
  const notices: TerminalNotice[] = [];
  const sizes: TerminalSize[] = [];
  const sink: TerminalSink = {
    sendState: (state) => states.push(state),
    sendOutput: ({ data }) => output.push(data),
    sendExit: (end) => exits.push(end),
    sendNotice: (notice) => notices.push(notice),
    sendSize: (size) => sizes.push(size),
  };
  return {
    sink,
    states,
    exits,
    notices,
    sizes,
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
    manager.write(id, second.sink, new TextEncoder().encode("echo done-$((1+1))\n"));
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
    const { sink } = createRecordingSink();
    const attached = manager.attach(id, sink, attachOptions);
    manager.detach(id, sink);
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
    manager.write(id, sink.sink, new TextEncoder().encode("echo second-$((2+2))\n"));
    manager.resize(id, sink.sink, 100, 30);
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
      onExit: (id, end) => exits.push({ id, end }),
    });
    const id = crypto.randomUUID();
    const sink = createRecordingSink();
    await manager.attach(id, sink.sink, { ...attachOptions, command: "exit 3" });
    await until(() => exits.length === 1);
    expect(exits).toEqual([{ id, end: { reason: "exited", exitCode: 3, outputLost: false } }]);
    expect(sink.exits).toEqual([{ reason: "exited", exitCode: 3, outputLost: false }]);
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
  readonly detached: string[] = [];
  readonly writes: string[] = [];
  readonly resizes: { cols: number; rows: number }[] = [];
  readonly acks: { syncOffset: number; bytes: number }[] = [];
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
  detach(id: string): void {
    this.detached.push(id);
  }
  write(_id: string, data: Uint8Array): void {
    this.writes.push(textDecoder.decode(data));
  }
  resize(_id: string, cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }
  setScrollback(): void {}
  ack(_id: string, syncOffset: number, bytes: number): void {
    this.acks.push({ syncOffset, bytes });
  }
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

  test("a client gets only its own attachment's states, and output only after its state", async () => {
    const host = new FakeTerminalHost();
    const manager = createManager([], host);
    const id = crypto.randomUUID();
    const client = createRecordingSink();
    await manager.attach(id, client.sink, attachOptions);
    manager.detach(id, client.sink);
    expect(host.detached).toEqual([id]);
    await manager.attach(id, client.sink, attachOptions);
    const [older, newer] = host.attaches.map((a) => a.attachment);
    expect(newer).not.toBe(older);

    // Still on its way from before the detach: the earlier attachment's state and output.
    host.emit({ type: "state", attachment: older!, state: state(id, "epoch-1", 0) });
    host.emit(output(id, 0));
    expect(client.states).toEqual([]);
    expect(client.outputText()).toBe("");

    host.emit({ type: "state", attachment: newer!, state: state(id, "epoch-1", 1) });
    host.emit(output(id, 1));
    expect(client.states.map((s) => s.offset)).toEqual([1]);
    expect(client.outputText()).toBe("a");
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

  test("a session lost with its host ends with the reason, and without a made-up exit code", async () => {
    const host = new FakeTerminalHost();
    const ends: TerminalEnd[] = [];
    const manager = createManager([], host, { onExit: (_id, end) => ends.push(end) });
    const lost = crypto.randomUUID();
    const unseen = crypto.randomUUID();
    const client = createRecordingSink();
    await manager.attach(lost, client.sink, attachOptions);
    await manager.ensureSpawned(unseen, attachOptions);
    const [lostSpawn, unseenSpawn] = host.spawns;

    host.emit({ type: "lost", id: lost, epoch: lostSpawn!.epoch, reason: "host_lost" });
    host.emit({ type: "lost", id: unseen, epoch: unseenSpawn!.epoch, reason: "exit_unknown" });
    expect(client.exits).toEqual([{ reason: "host_lost" }]);
    expect(ends).toEqual([
      { reason: "host_lost" },
      { reason: "exited", exitCode: null, outputLost: true },
    ]);
    expect(manager.running()).toEqual([]);
  });

  test("a session whose host stopped answering tells its panel, and keeps running", async () => {
    const host = new FakeTerminalHost();
    const manager = createManager([], host);
    const id = crypto.randomUUID();
    const client = createRecordingSink();
    await manager.attach(id, client.sink, attachOptions);
    const { epoch } = host.spawns[0]!;

    host.emit({ type: "unresponsive", id, epoch: crypto.randomUUID() });
    host.emit({ type: "unresponsive", id, epoch });
    expect(client.notices).toEqual([{ notice: "host_unresponsive" }]);
    expect(client.exits).toEqual([]);
    expect(manager.running().map((session) => session.id)).toEqual([id]);
  });

  test("an orphan the caller keeps (its panel is queued) is neither counted nor destroyed", async () => {
    const host = new FakeTerminalHost();
    const manager = createManager([], host);
    const queued = crypto.randomUUID();
    const orphan = crypto.randomUUID();
    await manager.ensureSpawned(queued, attachOptions);
    await manager.ensureSpawned(orphan, attachOptions);
    const kept = (id: string) => id === queued;

    expect(manager.destroyOrphans(kept)).toBe(1);
    expect(manager.running().map((session) => session.id)).toEqual([queued]);
    expect(manager.hasOrphanSessions(kept)).toBe(false);
    expect(manager.hasOrphanSessions()).toBe(true);
  });

  test("only a running session with no client attached and not kept is an orphan", async () => {
    const host = new FakeTerminalHost();
    const manager = createManager([], host);
    const [shared, queued, orphan] = [0, 1, 2].map(() => crypto.randomUUID());
    for (const id of [shared, queued, orphan]) await manager.ensureSpawned(id!, attachOptions);
    const first = createRecordingSink();
    const second = createRecordingSink();
    await manager.attach(shared!, first.sink, attachOptions);
    await manager.attach(shared!, second.sink, attachOptions);
    // One of its two windows leaving leaves it attached, so it is no orphan, kept or not.
    manager.detach(shared!, first.sink);
    const kept = (id: string) => id === queued;

    expect(manager.destroyOrphans(kept)).toBe(1);
    expect(
      manager
        .running()
        .map((session) => session.id)
        .toSorted(),
    ).toEqual([shared!, queued!].toSorted());
    expect(manager.hasOrphanSessions(kept)).toBe(false);

    // Once its last window leaves too, it is an orphan like any other.
    manager.detach(shared!, second.sink);
    expect(manager.destroyOrphans(kept)).toBe(1);
    expect(manager.running().map((session) => session.id)).toEqual([queued!]);
  });

  test("a session found ended on a reconnect is recorded at once, and drained when its panel mounts", async () => {
    const host = new FakeTerminalHost();
    let changes = 0;
    const manager = createManager([], host, { onSessionsChanged: () => changes++ });
    const id = crypto.randomUUID();
    await manager.ensureSpawned(id, attachOptions);
    const { epoch } = host.spawns[0]!;
    expect(manager.hasOrphanSessions()).toBe(true);

    const before = changes;
    host.emit({ type: "ended", id, epoch, exitCode: 5, outputKept: true });
    expect(changes).toBe(before + 1);
    expect(manager.running()).toEqual([]);
    expect(manager.hasOrphanSessions()).toBe(false);
    expect(manager.destroyOrphans()).toBe(0);

    const client = createRecordingSink();
    await manager.attach(id, client.sink, attachOptions);
    expect(host.spawns).toHaveLength(1);
    host.emit({ type: "exit", id, epoch, exitCode: 5 });
    expect(client.exits).toEqual([{ reason: "exited", exitCode: 5, outputLost: false }]);
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
    expect(first.exits).toEqual([{ reason: "exited", exitCode: 1, outputLost: false }]);
    expect(manager.get(id)).toBeUndefined();
    expect(host.attaches).toEqual([]);
  });

  test("a client that detaches before the spawn's answer is not bound", async () => {
    const host = new FakeTerminalHost();
    const manager = createManager([], host);
    const id = crypto.randomUUID();
    const { first, attached } = await attachWhileSpawning(host, manager, id);
    expect(manager.hasOrphanSessions()).toBe(false);

    manager.detach(id, first.sink);
    expect(manager.hasOrphanSessions()).toBe(true);
    host.answerSpawns();
    await attached;
    expect(host.attaches).toEqual([]);
    expect(manager.get(id)?.attached).toBe(false);
  });

  test("two attaches before the spawn's answer share the one attach in the host", async () => {
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
    expect(first.states).toHaveLength(1);
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
    const client = createRecordingSink().sink;
    const attached = manager.attach(id, client, attachOptions);
    manager.write(id, client, new TextEncoder().encode("typed"));
    manager.resize(id, client, 100, 30);
    release();
    await Promise.all([started, attached]);

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

describe("TerminalManager with several clients", () => {
  const epoch = "epoch-1";
  const snapshot = (id: string, offset: number): TerminalState => ({
    id,
    epoch,
    mode: "snapshot",
    offset,
    snapshot: "screen",
    cols: 80,
    rows: 24,
  });
  /** `bytes` bytes of output at `offset`, all "a". */
  const output = (id: string, offset: number, bytes = 1): TerminalHostEvent => {
    const frame = encodeOutputFrame(id, offset, new Uint8Array(bytes).fill(0x61));
    return { type: "output", id, offset, data: frame.subarray(BIN_OUTPUT_HEADER_SIZE), frame };
  };
  /** The attachment of the host's latest attach. */
  const lastAttachment = (host: FakeTerminalHost) => host.attaches.at(-1)!.attachment;

  /** A session `id` with two clients attached, `first` then `second`, both synced at offset 0. */
  async function twoClients(host: FakeTerminalHost, manager: TerminalManager, id: string) {
    const first = createRecordingSink();
    const second = createRecordingSink();
    await manager.attach(id, first.sink, attachOptions);
    host.emit({ type: "state", attachment: lastAttachment(host), state: snapshot(id, 0) });
    await manager.attach(id, second.sink, attachOptions);
    host.emit({ type: "state", attachment: lastAttachment(host), state: snapshot(id, 0) });
    return { first, second };
  }

  test("a client joins with a snapshot while the one attached carries on", async () => {
    const host = new FakeTerminalHost();
    const manager = createManager([], host);
    const id = crypto.randomUUID();
    const first = createRecordingSink();
    await manager.attach(id, first.sink, attachOptions);
    host.emit({ type: "state", attachment: lastAttachment(host), state: snapshot(id, 0) });
    host.emit(output(id, 0));

    const second = createRecordingSink();
    await manager.attach(id, second.sink, attachOptions);
    expect(host.attaches.map((a) => a.since)).toEqual([undefined, undefined]);
    // Output already on its way under the first attachment goes on to the first client.
    host.emit(output(id, 1));
    host.emit({ type: "state", attachment: lastAttachment(host), state: snapshot(id, 2) });
    host.emit(output(id, 2));

    expect(first.states.map((s) => s.offset)).toEqual([0]);
    expect(first.outputText()).toBe("aaa");
    expect(second.states.map((s) => s.offset)).toEqual([2]);
    expect(second.outputText()).toBe("a");
    expect(manager.get(id)?.attached).toBe(true);
  });

  test("clients that share a point resume from it, and one joining meanwhile waits for a snapshot", async () => {
    const host = new FakeTerminalHost();
    const manager = createManager([], host);
    const id = crypto.randomUUID();
    await manager.ensureSpawned(id, attachOptions);
    const since = { sinceEpoch: epoch, sinceOffset: 5 };
    const [first, second, joining] = [0, 1, 2].map(() => createRecordingSink());
    void manager.attach(id, first!.sink, { ...attachOptions, ...since });
    void manager.attach(id, second!.sink, { ...attachOptions, ...since });
    await until(() => host.attaches.length === 1);
    expect(host.attaches[0]!.since).toEqual({ epoch, offset: 5 });

    // Joins while that resume is on its way, from no point: its attach waits for the next one.
    let joined = false;
    void manager.attach(id, joining!.sink, attachOptions).then(() => (joined = true));
    const resume: TerminalState = { ...snapshot(id, 5), mode: "resume", snapshot: undefined };
    host.emit({ type: "state", attachment: lastAttachment(host), state: resume });
    expect(first!.states).toEqual([resume]);
    expect(second!.states).toEqual([resume]);
    expect(joining!.states).toEqual([]);
    await until(() => host.attaches.length === 2);
    expect(host.attaches[1]!.since).toBeUndefined();
    expect(joined).toBe(false);

    host.emit(output(id, 5));
    host.emit({ type: "state", attachment: lastAttachment(host), state: snapshot(id, 6) });
    await until(() => joined);
    expect(joining!.states.map((s) => s.offset)).toEqual([6]);
    expect(first!.states).toHaveLength(1);
    expect(first!.outputText()).toBe("a");
  });

  test("clients waiting from different points get one snapshot", async () => {
    const host = new FakeTerminalHost();
    const manager = createManager([], host);
    const id = crypto.randomUUID();
    await manager.ensureSpawned(id, attachOptions);
    const reconnected = createRecordingSink();
    const fresh = createRecordingSink();
    void manager.attach(id, reconnected.sink, {
      ...attachOptions,
      sinceEpoch: epoch,
      sinceOffset: 5,
    });
    void manager.attach(id, fresh.sink, attachOptions);
    await until(() => host.attaches.length === 1);
    expect(host.attaches[0]!.since).toBeUndefined();
    host.emit({ type: "state", attachment: lastAttachment(host), state: snapshot(id, 9) });
    expect(reconnected.states.map((s) => s.offset)).toEqual([9]);
    expect(fresh.states.map((s) => s.offset)).toEqual([9]);
    expect(host.attaches).toHaveLength(1);
  });

  test("only the active client's input is written, and the PTY takes its size", async () => {
    const host = new FakeTerminalHost();
    const manager = createManager([], host);
    const id = crypto.randomUUID();
    const first = createRecordingSink();
    const second = createRecordingSink();
    await manager.attach(id, first.sink, attachOptions);
    // Joining a terminal another client uses does not resize it: it renders at the PTY's size.
    await manager.attach(id, second.sink, { ...attachOptions, cols: 100, rows: 30 });
    expect(host.resizes).toEqual([]);
    expect(second.sizes).toEqual([{ cols: 80, rows: 24 }]);
    expect(first.sizes).toEqual([]);

    // The second client's xterm answers the program's queries too; only the active one counts.
    const type = (client: TerminalSink, text: string) =>
      manager.write(id, client, new TextEncoder().encode(text));
    type(first.sink, "from-first");
    type(second.sink, "from-second");
    expect(host.writes).toEqual(["from-first"]);

    // Its user typing claims the terminal, at its own size.
    manager.resize(id, second.sink, 100, 30);
    type(second.sink, "typed");
    type(first.sink, "reply");
    expect(host.writes).toEqual(["from-first", "typed"]);
    expect(host.resizes).toEqual([{ cols: 100, rows: 30 }]);
    expect(first.sizes).toEqual([{ cols: 100, rows: 30 }]);
    // A claim that changes nothing sends nothing.
    manager.resize(id, second.sink, 100, 30);
    expect(host.resizes).toHaveLength(1);
    expect(first.sizes).toHaveLength(1);

    // The active client leaving hands input to none until the other claims, at the size it
    // already renders at.
    manager.detach(id, second.sink);
    type(first.sink, "unclaimed");
    manager.resize(id, first.sink, 100, 30);
    type(first.sink, "now-first");
    expect(host.writes).toEqual(["from-first", "typed", "now-first"]);
    expect(host.resizes).toHaveLength(1);
  });

  test("the active client leaving makes none active, and the next claim takes over", async () => {
    const host = new FakeTerminalHost();
    const manager = createManager([], host);
    const id = crypto.randomUUID();
    const first = createRecordingSink();
    const second = createRecordingSink();
    await manager.attach(id, first.sink, attachOptions);
    await manager.attach(id, second.sink, attachOptions);
    const type = (client: TerminalSink, text: string) =>
      manager.write(id, client, new TextEncoder().encode(text));

    // As the server does on a re-attach (a worktree switch and back): the old sink goes, and a
    // new one attaches, joining the other client without resizing anything.
    manager.detach(id, first.sink);
    type(second.sink, "reply");
    expect(host.writes).toEqual([]);
    const again = createRecordingSink();
    void manager.attach(id, again.sink, { ...attachOptions, cols: 90, rows: 20 });
    expect(host.resizes).toEqual([]);
    expect(again.sizes).toEqual([{ cols: 80, rows: 24 }]);
    expect(second.sizes).toEqual([{ cols: 80, rows: 24 }]);

    manager.resize(id, again.sink, 90, 20);
    type(again.sink, "typed");
    expect(host.writes).toEqual(["typed"]);
    expect(host.resizes).toEqual([{ cols: 90, rows: 20 }]);
  });

  test("a client detaching leaves the others attached; the last one leaves an orphan", async () => {
    const host = new FakeTerminalHost();
    const manager = createManager([], host);
    const id = crypto.randomUUID();
    const { first, second } = await twoClients(host, manager, id);

    manager.detach(id, first.sink);
    host.emit(output(id, 0));
    expect(second.outputText()).toBe("a");
    expect(first.outputText()).toBe("");
    expect(host.detached).toEqual([]);
    expect(manager.hasOrphanSessions()).toBe(false);

    manager.detach(id, second.sink);
    expect(host.detached).toEqual([id]);
    expect(manager.hasOrphanSessions()).toBe(true);
  });

  test("every attached client gets the exit and the host's notices", async () => {
    const host = new FakeTerminalHost();
    const manager = createManager([], host);
    const id = crypto.randomUUID();
    const { first, second } = await twoClients(host, manager, id);
    const { epoch: spawned } = host.spawns[0]!;
    host.emit({ type: "unresponsive", id, epoch: spawned });
    host.emit({ type: "exit", id, epoch: spawned, exitCode: 3 });
    for (const client of [first, second]) {
      expect(client.notices).toEqual([{ notice: "host_unresponsive" }]);
      expect(client.exits).toEqual([{ reason: "exited", exitCode: 3, outputLost: false }]);
    }
  });

  describe("flow control", () => {
    const KIB = 1024;
    const flow = { highWaterBytes: 100 * KIB, lowWaterBytes: 10 * KIB };

    test("a slow client is paused and caught up with a snapshot, and never holds up the fast one", async () => {
      const host = new FakeTerminalHost();
      const manager = new TerminalManager(
        host,
        {
          isSequenceEnabled: () => false,
          onNotification: () => {},
          onExit: () => {},
          toolchainEnvs: [],
        },
        flow,
      );
      managers.push(manager);
      const id = crypto.randomUUID();
      const { first: fast, second: slow } = await twoClients(host, manager, id);
      const chunk = 64 * KIB;

      // The fast client acks everything; the slow one nothing, until it is past its budget.
      for (const offset of [0, chunk, 2 * chunk]) {
        host.emit(output(id, offset, chunk));
        manager.ack(id, fast.sink, 0, chunk);
      }
      expect(fast.outputText()).toHaveLength(3 * chunk);
      expect(slow.outputText()).toHaveLength(2 * chunk);
      // The host is acknowledged as far as the fast client parsed, so it keeps sending.
      expect(host.acks).toEqual([0, 1, 2].map(() => ({ syncOffset: 0, bytes: chunk })));

      // Once its acks bring it under the low water mark, it alone gets a snapshot.
      manager.ack(id, slow.sink, 0, 2 * chunk - 5 * KIB);
      expect(host.acks).toHaveLength(3);
      expect(host.attaches).toHaveLength(3);
      host.emit({
        type: "state",
        attachment: lastAttachment(host),
        state: snapshot(id, 3 * chunk),
      });
      host.emit(output(id, 3 * chunk));
      expect(slow.states.map((s) => s.offset)).toEqual([0, 3 * chunk]);
      expect(fast.states.map((s) => s.offset)).toEqual([0]);
      expect(slow.outputText()).toHaveLength(2 * chunk + 1);
      expect(fast.outputText()).toHaveLength(3 * chunk + 1);
    });

    test("a client paused when its program exits gets the end of the output before the exit", async () => {
      process.env.SHELL = "/bin/sh";
      // The host's budget is the clients': it pauses with them, and resyncs before the exit.
      const host = new InProcessTerminalHost({ log: createNoopLogger(), flowControl: flow });
      const manager = new TerminalManager(
        host,
        {
          isSequenceEnabled: () => false,
          onNotification: () => {},
          onExit: () => {},
          toolchainEnvs: [],
        },
        flow,
      );
      managers.push(manager);
      const id = crypto.randomUUID();
      // Never acks: it is paused past 100 KiB of the 150 KB the command prints.
      const client = createRecordingSink();
      await manager.attach(id, client.sink, {
        ...attachOptions,
        command: "head -c 150000 /dev/zero | tr '\\0' a; echo; echo THE-''END; exit 0",
      });
      await until(() => client.exits.length > 0, 30_000);
      expect(client.states.length).toBeGreaterThan(1);
      const shown = (client.states.at(-1)?.snapshot ?? "") + client.outputText();
      expect(shown).toContain("THE-END");
    });

    test("a client paused next to one keeping up gets the end of the output before the exit", async () => {
      process.env.SHELL = "/bin/sh";
      const host = new InProcessTerminalHost({ log: createNoopLogger(), flowControl: flow });
      const manager = new TerminalManager(
        host,
        {
          isSequenceEnabled: () => false,
          onNotification: () => {},
          onExit: () => {},
          toolchainEnvs: [],
        },
        flow,
      );
      managers.push(manager);
      const id = crypto.randomUUID();
      // Never acks: it is paused past 100 KiB of the 150 KB the command prints.
      const slow = createRecordingSink();
      await manager.attach(id, slow.sink, {
        ...attachOptions,
        command: "read go; head -c 150000 /dev/zero | tr '\\0' a; echo; echo THE-''END; exit 0",
      });
      // Acks each chunk as it gets it, so it never falls behind (each chunk is far under the
      // budget), the host never pauses, and makes no final resync of its own.
      const fast = createRecordingSink();
      const acking: TerminalSink = {
        ...fast.sink,
        sendOutput: (output) => {
          fast.sink.sendOutput(output);
          manager.ack(id, acking, fast.states.at(-1)!.offset, output.data.byteLength);
        },
      };
      await manager.attach(id, acking, attachOptions);
      manager.resize(id, acking, attachOptions.cols, attachOptions.rows);
      manager.write(id, acking, new TextEncoder().encode("\n"));

      await until(() => slow.exits.length > 0 && fast.exits.length > 0, 30_000);
      expect(fast.states).toHaveLength(1);
      expect(fast.outputText()).toContain("THE-END");
      const shown = (slow.states.at(-1)?.snapshot ?? "") + slow.outputText();
      expect(shown).toContain("THE-END");
    });
  });
});

describe("TerminalManager with several clients of a real shell", () => {
  const originalShell = process.env.SHELL;
  afterEach(() => {
    process.env.SHELL = originalShell;
  });

  test("both clients see the output, and either can type once it claims the terminal", async () => {
    process.env.SHELL = "/bin/sh";
    const manager = createManager();
    const id = crypto.randomUUID();
    const first = createRecordingSink();
    const second = createRecordingSink();
    await manager.attach(id, first.sink, attachOptions);
    await manager.attach(id, second.sink, attachOptions);
    const typeIn = (client: TerminalSink, line: string) => {
      manager.resize(id, client, attachOptions.cols, attachOptions.rows);
      manager.write(id, client, new TextEncoder().encode(`${line}\n`));
    };
    /** What the client shows: its latest snapshot, then the output after it. */
    const shows = (client: ReturnType<typeof createRecordingSink>) =>
      (client.states.at(-1)?.snapshot ?? "") + client.outputText();

    // Quoted apart, so the echo of the typed line itself never reads as the output.
    typeIn(first.sink, 'echo fr""om-first');
    await until(() => shows(first).includes("from-first\r\n"));
    await until(() => shows(second).includes("from-first\r\n"));
    typeIn(second.sink, 'echo fr""om-second');
    await until(() => shows(first).includes("from-second\r\n"));
    await until(() => shows(second).includes("from-second\r\n"));

    // One leaving leaves the other attached to the same shell.
    manager.detach(id, first.sink);
    typeIn(second.sink, 'echo st""ill-here');
    await until(() => shows(second).includes("still-here\r\n"));
    expect(shows(first)).not.toContain("still-here");
    expect(manager.get(id)?.attached).toBe(true);
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

  test("an adopted session that ended meanwhile is neither running nor ended as an orphan", async () => {
    const host = new FakeTerminalHost();
    const manager = createManager([], host);
    const ended = {
      ...info({ worktreePath: "/wt/a", cwd: "/wt/a" }),
      ended: { exitCode: 2, outputKept: true },
    };
    manager.adopt([ended]);
    expect(manager.running()).toEqual([]);
    expect(manager.hasOrphanSessions()).toBe(false);
    expect(manager.destroyOrphans()).toBe(0);
    expect(host.destroyed).toEqual([]);

    // Its panel mounts later and drains what it missed; the host then reports the exit.
    const client = createRecordingSink();
    await manager.attach(ended.id, client.sink, attachOptions);
    expect(host.spawns).toEqual([]);
    expect(host.attaches).toEqual([expect.objectContaining({ id: ended.id })]);
    host.emit({ type: "exit", id: ended.id, epoch: ended.epoch, exitCode: 2 });
    expect(client.exits).toEqual([{ reason: "exited", exitCode: 2, outputLost: false }]);
    expect(manager.get(ended.id)).toBeUndefined();
  });

  test("an ended session whose output the host let go of says so on its exit", async () => {
    const host = new FakeTerminalHost();
    const manager = createManager([], host);
    const ended = {
      ...info({ worktreePath: "/wt/a", cwd: "/wt/a" }),
      ended: { exitCode: 1, outputKept: false },
    };
    manager.adopt([ended]);
    const client = createRecordingSink();
    await manager.attach(ended.id, client.sink, attachOptions);
    host.emit({ type: "exit", id: ended.id, epoch: ended.epoch, exitCode: 1 });
    expect(client.exits).toEqual([{ reason: "exited", exitCode: 1, outputLost: true }]);
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
