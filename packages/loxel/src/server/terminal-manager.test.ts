import { afterEach, describe, expect, test } from "bun:test";

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

function createManager(initialCommandTtlMs?: number): TerminalManager {
  const manager = new TerminalManager(
    { isSequenceEnabled: () => false, onNotification: () => {}, onExit: () => {} },
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
