import { beforeEach, describe, expect, test } from "bun:test";

import type { AgentTerminalsState } from "@/api/agent-terminal-model";

import { AgentTerminals, type StoredAsk } from "./agent-terminals";

const HOUR = 60 * 60_000;

const request = (
  worktreePath: string | null,
  windowId?: string,
): Omit<StoredAsk, "id" | "askedAt"> => ({
  origin: { agent: "Codex" },
  cwd: worktreePath ?? "/home",
  worktreePath,
  command: "make",
  placement: { split: "right" },
  focus: false,
  ...(windowId ? { windowId } : {}),
});

describe("AgentTerminals", () => {
  let now: number;
  let always: string | null;
  let published: AgentTerminalsState[];

  const create = () =>
    new AgentTerminals({
      now: () => now,
      loadAlways: () => always,
      saveAlways: (json) => {
        always = json;
      },
      onChange: (state) => published.push(state),
    });

  beforeEach(() => {
    now = 1_000_000;
    always = null;
    published = [];
  });

  test("hands a request over once, and shows windows no placement", () => {
    const asks = create();
    const ask = asks.ask(request("/wt", "w1"))!;

    expect(published.at(-1)?.asks).toEqual([
      {
        id: ask.id,
        askedAt: now,
        windowId: "w1",
        origin: { agent: "Codex" },
        cwd: "/wt",
        worktreePath: "/wt",
        command: "make",
      },
    ]);
    expect(asks.take(ask.id)).toEqual(ask);
    expect(asks.take(ask.id)).toBeNull();
    expect(published.at(-1)?.asks).toEqual([]);
  });

  test("keeps the worktrees that always run across a restart", () => {
    create().runAlways("/other");

    const restarted = create();
    expect(restarted.runsAlways("/other")).toBe(true);
    expect(restarted.runsAlways("/wt")).toBe(false);
    expect(restarted.runsAlways(null)).toBe(false);
  });

  test("asks in the window that says hello what no connected window asks", () => {
    const asks = create();
    asks.ask(request("/a"));
    asks.ask(request("/b", "w1"));
    asks.ask(request("/c", "gone"));

    asks.windowConnected("w2", (windowId) => windowId === "w1" || windowId === "w2");

    expect(asks.state().asks.map((ask) => [ask.worktreePath, ask.windowId])).toEqual([
      ["/a", "w2"],
      ["/b", "w1"],
      ["/c", "w2"],
    ]);
  });

  test("waits for the next window when the last one closes", () => {
    const asks = create();
    asks.ask(request("/a", "w1"));
    const before = published.length;

    asks.windowClosed(() => false, null);

    expect(asks.state().asks[0]?.windowId).toBeUndefined();
    expect(published).toHaveLength(before + 1);
    // Nothing changed: nothing is published.
    asks.windowClosed(() => false, null);
    expect(published).toHaveLength(before + 1);
  });

  test("a window that reloads takes its requests back from the window they moved to", () => {
    const asks = create();
    asks.ask(request("/a", "w1"));
    asks.ask(request("/b"));
    asks.windowConnected("w1", (windowId) => windowId === "w1");

    // w1 reloads while w2 is open: its requests go to w2, then come back.
    asks.windowClosed((windowId) => windowId === "w2", "w2");
    expect(asks.state().asks.map((ask) => ask.windowId)).toEqual(["w2", "w2"]);
    asks.windowConnected("w1", () => true);

    expect(asks.state().asks.map((ask) => ask.windowId)).toEqual(["w1", "w1"]);
  });

  test("hands over a worktree's waiting requests at once", () => {
    const asks = create();
    asks.ask(request("/wt"));
    asks.ask(request("/other"));
    asks.ask(request("/wt"));

    expect(asks.takeWorktree("/wt")).toHaveLength(2);
    expect(asks.state().asks.map((ask) => ask.worktreePath)).toEqual(["/other"]);
  });

  test("follows a moved worktree", () => {
    const asks = create();
    asks.ask(request("/old"));
    asks.runAlways("/old");

    asks.moveWorktree("/old", "/new");

    expect(asks.state()).toEqual({
      asks: [expect.objectContaining({ worktreePath: "/new" })],
      alwaysWorktrees: ["/new"],
    });
    expect(always).toBe(JSON.stringify(["/new"]));
  });

  test("lets a request expire after 72 hours", () => {
    const asks = create();
    const old = asks.ask(request("/wt"))!;
    now += 71 * HOUR;
    asks.ask(request("/wt"));
    now += 2 * HOUR;

    expect(asks.take(old.id)).toBeNull();
    expect(published.at(-1)?.asks).toHaveLength(1);
  });

  test("refuses requests past its limit", () => {
    const asks = create();
    for (let i = 0; i < 100; i++) expect(asks.ask(request(`/wt${i}`))).not.toBeNull();

    expect(asks.ask(request("/one-more"))).toBeNull();
  });

  test("forgets a removed worktree's requests and that it always runs", () => {
    const asks = create();
    asks.ask(request("/wt"));
    asks.ask(request("/other"));
    asks.runAlways("/wt");

    asks.dropWorktree("/wt");

    expect(asks.state()).toEqual({
      asks: [expect.objectContaining({ worktreePath: "/other" })],
      alwaysWorktrees: [],
    });
    expect(always).toBe("[]");
  });

  test("clears the worktrees that always run", () => {
    always = JSON.stringify(["/a", "/b"]);
    const asks = create();

    asks.clearAlways();

    expect(asks.runsAlways("/a")).toBe(false);
    expect(published.at(-1)?.alwaysWorktrees).toEqual([]);
    expect(always).toBe("[]");
  });

  test("starts with no worktrees that always run when what was saved is unreadable", () => {
    always = "{not json";
    expect(create().state().alwaysWorktrees).toEqual([]);
    always = JSON.stringify({ worktrees: [] });
    expect(create().state().alwaysWorktrees).toEqual([]);
  });
});
