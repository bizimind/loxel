import { afterEach, describe, expect, test } from "bun:test";

import { createNoopLogger } from "@bizimind/logger";

import { until } from "@/test/until";

import { InProcessTerminalHost } from "./in-process-terminal-host";
import type { TerminalHostEvent, TerminalSpawnRequest } from "./terminal-host";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const hosts: InProcessTerminalHost[] = [];
afterEach(async () => {
  const pids: number[] = [];
  for (const host of hosts.splice(0)) {
    for (const session of await host.list()) {
      pids.push(session.pid);
      host.destroy(session.id);
    }
  }
  await until(() => pids.every(processGone));
});

/** True once the process is gone, reaped included, which is when its exit has been handled. */
function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

function createHost() {
  const host = new InProcessTerminalHost({ log: createNoopLogger() });
  hosts.push(host);
  const events: TerminalHostEvent[] = [];
  host.onEvent((event) => events.push(event));
  const outputText = (id: string) =>
    events
      .map((event) => (event.type === "output" && event.id === id ? event.data : null))
      .filter((data) => data !== null)
      .map((data) => textDecoder.decode(data))
      .join("");
  return { host, events, outputText };
}

function request(
  script: string,
  overrides: Partial<TerminalSpawnRequest> = {},
): TerminalSpawnRequest {
  return {
    id: crypto.randomUUID(),
    epoch: crypto.randomUUID(),
    argv: ["/bin/sh", "-c", script],
    cwd: "/tmp",
    env: { PATH: "/usr/bin:/bin", TERM: "xterm-256color" },
    cols: 80,
    rows: 24,
    scrollbackLines: 1_000,
    meta: { worktreePath: "/wt/a" },
    ...overrides,
  };
}

describe("InProcessTerminalHost", () => {
  test("spawn reports the session, and list reports it with the meta last set", async () => {
    const { host } = createHost();
    const spawned = request("exec sleep 30", { cols: 50_000 });
    const info = await host.spawn(spawned);

    expect(info).toMatchObject({
      id: spawned.id,
      epoch: spawned.epoch,
      offset: 0,
      cols: 1_000,
      rows: 24,
    });
    expect(info.meta).toEqual({ worktreePath: "/wt/a" });
    expect(info.pid).toBeGreaterThan(0);
    expect(processGone(info.pid)).toBe(false);

    host.setMeta(spawned.id, { worktreePath: "/wt/b", windowId: "w1" });
    host.resize(spawned.id, 100, 30);
    expect(await host.list()).toEqual([
      { ...info, cols: 100, rows: 30, meta: { worktreePath: "/wt/b", windowId: "w1" } },
    ]);
  });

  test("typed-ahead input reaches the program before input written after the spawn", async () => {
    const { host, outputText } = createHost();
    const spawned = request(String.raw`read a; read b; echo "got-$a-$b"; exec sleep 30`, {
      input: textEncoder.encode("first\n"),
    });
    await host.spawn(spawned);
    host.write(spawned.id, textEncoder.encode("second\n"));
    await host.attach({ id: spawned.id, attachment: 1 });
    await until(() => outputText(spawned.id).includes("got-first-second"));
  });

  test("states carry the attachment, and output follows the state of the client it is for", async () => {
    const { host, events } = createHost();
    const spawned = request(`sleep 0.2; printf 'later\\n'; exec sleep 30`);
    const info = await host.spawn(spawned);
    await host.attach({ id: spawned.id, attachment: 7 });

    await until(() => events.some((e) => e.type === "output"));
    const [state, output] = events;
    expect(state).toMatchObject({
      type: "state",
      attachment: 7,
      state: { id: spawned.id, epoch: info.epoch, mode: "snapshot", offset: 0 },
    });
    expect(output).toMatchObject({ type: "output", id: spawned.id, offset: 0 });
  });

  test("an attach with a since point in range resumes from it instead of a snapshot", async () => {
    const { host, events, outputText } = createHost();
    // The notification marks the moment the line has been parsed.
    const spawned = request(String.raw`printf 'first\n\033]9;printed\007'; exec sleep 30`);
    const info = await host.spawn(spawned);
    await until(() => events.some((e) => e.type === "osc"));

    await host.attach({ id: spawned.id, attachment: 1, since: { epoch: info.epoch, offset: 0 } });
    expect(events[1]).toMatchObject({
      type: "state",
      attachment: 1,
      state: { mode: "resume", offset: 0 },
    });
    expect(outputText(spawned.id)).toContain("first");
  });

  test("notification sequences are reported raw with the session's epoch, attached or not", async () => {
    const { host, events } = createHost();
    const spawned = request(String.raw`printf '\033]9;one\007\033]777;two\007'; exec sleep 30`);
    const info = await host.spawn(spawned);
    await until(() => events.filter((e) => e.type === "osc").length === 2);
    expect(events).toEqual([
      { type: "osc", id: spawned.id, epoch: info.epoch, code: 9, data: "one" },
      { type: "osc", id: spawned.id, epoch: info.epoch, code: 777, data: "two" },
    ]);
  });

  test("a program that ends is gone from the list by the time its exit is delivered", async () => {
    const { host, events } = createHost();
    const spawned = request("exit 3");
    const listed: unknown[][] = [];
    host.onEvent((event) => {
      if (event.type === "exit") void host.list().then((sessions) => listed.push(sessions));
    });
    const info = await host.spawn(spawned);
    await until(() => listed.length === 1);
    expect(events).toContainEqual({ type: "exit", id: spawned.id, epoch: info.epoch, exitCode: 3 });
    expect(listed).toEqual([[]]);
  });

  test("a destroyed session is gone at once and its ID can be reused, without an exit", async () => {
    const { host, events } = createHost();
    const spawned = request("exec sleep 30");
    const first = await host.spawn(spawned);
    host.destroy(spawned.id);
    expect(await host.list()).toEqual([]);

    const second = await host.spawn({ ...spawned, epoch: crypto.randomUUID() });
    await until(() => processGone(first.pid));
    expect((await host.list()).map((s) => s.epoch)).toEqual([second.epoch]);
    expect(events.filter((e) => e.type === "exit")).toEqual([]);
  });

  test("spawn rejects an ID in use and a program that cannot start", async () => {
    const { host } = createHost();
    const spawned = request("exec sleep 30");
    await host.spawn(spawned);
    await expect(host.spawn(spawned)).rejects.toThrow(`Terminal ${spawned.id} is already running`);

    const missing = request("", { argv: ["/nonexistent/loxel-test-shell"] });
    const failure = await host.spawn(missing).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof Error && failure.cause).toBeTruthy();
    expect((await host.list()).map((s) => s.id)).toEqual([spawned.id]);
  });

  test("commands for an unknown ID do nothing", async () => {
    const { host, events } = createHost();
    const id = crypto.randomUUID();
    await host.attach({ id, attachment: 1 });
    host.detach(id);
    host.write(id, textEncoder.encode("x"));
    host.resize(id, 100, 30);
    host.setScrollback(id, 5_000);
    host.ack(id, 0, 10);
    host.setMeta(id, {});
    host.destroy(id);
    expect(events).toEqual([]);
    expect(await host.list()).toEqual([]);
  });

  test("an unsubscribed listener gets no more events", async () => {
    const { host } = createHost();
    const received: TerminalHostEvent[] = [];
    const unsubscribe = host.onEvent((event) => received.push(event));
    unsubscribe();
    const spawned = request("exec sleep 30");
    await host.spawn(spawned);
    await host.attach({ id: spawned.id, attachment: 1 });
    expect(received).toEqual([]);
  });
});
