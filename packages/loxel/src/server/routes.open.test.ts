import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentTerminalPolicy, AgentTerminalsState } from "@/api/agent-terminal-model";
import { createNoopLogger } from "@/api/log-entry-model";
import type { WsMessage } from "@/api/ws-protocol";
import { InProcessTerminalHost } from "@/terminal-host";
import { until } from "@/test/until";

import { AgentTerminals } from "./agent-terminals";
import type { InboxMessage } from "./open-inbox";
import type { ActiveWindow, RouteContext } from "./routes";
import { handleRequest } from "./routes";
import { TerminalManager } from "./terminal-manager";

type StartedTerminal = Parameters<RouteContext["startTerminal"]>[0];
type QueuedOpen = { message: InboxMessage; worktreePath: string | null | undefined };

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "ignore", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
}

describe("POST /api/open terminals and placement", () => {
  let root: string;
  let ctx: RouteContext;
  let sent: Array<{ windowId: string | null; msg: WsMessage }>;
  let started: StartedTerminal[];
  let window: ActiveWindow | null;
  let queued: QueuedOpen[];
  let inboxRoom: number;
  let policy: AgentTerminalPolicy;
  let agentState: AgentTerminalsState;

  beforeEach(async () => {
    root = realpathSync(await mkdtemp(join(tmpdir(), "loxel-open-")));
    await writeFile(join(root, "file.txt"), "x");
    sent = [];
    started = [];
    queued = [];
    inboxRoom = 10;
    window = { windowId: "w1", worktreePath: "/projects/app" };
    policy = "run";
    agentState = { asks: [], alwaysWorktrees: [] };
    ctx = {
      broadcastToSubscribers: () => {},
      broadcastToProject: () => {},
      broadcastAll: () => {},
      sendToActiveWindow: (windowId, msg) => {
        if (!window) return false;
        sent.push({ windowId, msg });
        return true;
      },
      sendToWorktreeWindows: () => false,
      externalFolderConflict: () => null,
      getProject: () => undefined,
      findProjectForPath: () => undefined,
      getWorktreeResources: () => undefined,
      suspendWorktreeWatchers: async () => async () => {},
      completeWorktreeRemoval: () => {},
      resolveFilePath: () => null,
      initializeProject: async () => ({ project: {} as never, worktrees: [] }),
      teardownProject: () => {},
      isShuttingDown: () => false,
      resolveSchema: async () => ({}),
      schemaConsent: {} as never,
      ensureSchemas: async () => {},
      updateYamlSchemas: () => {},
      updateTomlSchemas: () => {},
      formatContent: async () => ({ content: null }),
      getDetectedFormatters: () => [],
      activeWindow: () => window,
      homeDrafts: {} as never,
      startTerminal: async (target) => {
        started.push(target);
      },
      listTerminals: async () => ({ terminals: [] }),
      queueForWindow: (message, worktreePath) => {
        if (queued.length >= inboxRoom) return "full";
        queued.push({ message, worktreePath });
        return "queued";
      },
      dropQueuedTerminal: (id) => {
        queued = queued.filter(
          ({ message }) => message.type !== "open_terminal" || message.data.terminalId !== id,
        );
      },
      agentTerminals: new AgentTerminals({
        loadAlways: () => null,
        saveAlways: () => {},
        onChange: (state) => {
          agentState = state;
        },
      }),
      agentTerminalPolicy: () => policy,
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function open(body: unknown): Promise<Response> {
    const req = new Request("http://127.0.0.1:7434/api/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return handleRequest(req, ctx);
  }

  function sentTerminal() {
    const msg = sent[0]?.msg;
    if (msg?.type !== "open_terminal") throw new Error(`Expected open_terminal, got ${msg?.type}`);
    return msg.data;
  }

  test("sends the window a terminal to create and starts its shell with the command", async () => {
    const res = await open({
      terminal: { cwd: root, command: "claude 'do it'", title: "claude" },
      windowId: "w1",
    });

    expect(res.status).toBe(200);
    const data = sentTerminal();
    expect(sent[0]!.windowId).toBe("w1");
    // Outside every project, the terminal belongs to the worktree the window shows.
    const worktreePath = "/projects/app";
    expect(data).toEqual({ terminalId: data.terminalId, cwd: root, worktreePath, title: "claude" });
    expect(started).toEqual([
      { id: data.terminalId, cwd: root, worktreePath, windowId: "w1", command: "claude 'do it'" },
    ]);
    expect(await res.json()).toEqual({ ok: true, terminalId: data.terminalId });
  });

  test("a terminal without a command starts a plain shell and carries no title", async () => {
    window = { windowId: null, worktreePath: "/projects/app" };
    const res = await open({ terminal: { cwd: root } });

    expect(res.status).toBe(200);
    const { terminalId } = sentTerminal();
    expect(sentTerminal()).toEqual({ terminalId, cwd: root, worktreePath: "/projects/app" });
    expect(sent[0]!.windowId).toBeNull();
    expect(started).toEqual([{ id: terminalId, cwd: root, worktreePath: "/projects/app" }]);
  });

  test("canonicalizes the directory", async () => {
    const res = await open({ terminal: { cwd: `${root}/./` } });

    expect(res.status).toBe(200);
    expect(sentTerminal().cwd).toBe(root);
  });

  test("rejects a missing directory and a file", async () => {
    expect((await open({ terminal: { cwd: join(root, "nope") } })).status).toBe(404);
    expect((await open({ terminal: { cwd: join(root, "file.txt") } })).status).toBe(400);
    expect(sent).toEqual([]);
    expect(started).toEqual([]);
  });

  test("rejects malformed terminal bodies", async () => {
    expect((await open({ terminal: "x" })).status).toBe(400);
    expect((await open({ terminal: {} })).status).toBe(400);
    expect((await open({ terminal: { cwd: root, command: 1 } })).status).toBe(400);
    expect((await open({ terminal: { cwd: root, title: [] } })).status).toBe(400);
    expect(sent).toEqual([]);
  });

  test("rejects a command holding control characters, which the shell would read as keys", async () => {
    for (const command of ["npm test\rls", "a\tb", "claude 'x\u0015y'", "ls\u001b[D"]) {
      const res = await open({ terminal: { cwd: root, command } });
      expect(res.status).toBe(400);
    }
    expect(sent).toEqual([]);
    expect(started).toEqual([]);
  });

  test("accepts a command spanning several lines", async () => {
    const res = await open({ terminal: { cwd: root, command: "claude 'one\ntwo'" } });

    expect(res.status).toBe(200);
    expect(started).toMatchObject([{ command: "claude 'one\ntwo'" }]);
  });

  test("starts no shell while no window can take the terminal", async () => {
    window = null;

    const res = await open({ terminal: { cwd: root, command: "ls" } });

    expect(res.status).toBe(503);
    expect(started).toEqual([]);
  });

  test("with queue, starts the shell and keeps the panel for the next window", async () => {
    window = null;

    const res = await open({ terminal: { cwd: root, command: "ls", title: "ls" }, queue: true });

    expect(res.status).toBe(202);
    const { terminalId } = (await res.json()) as { terminalId: string };
    expect(started).toEqual([{ id: terminalId, cwd: root, command: "ls" }]);
    expect(sent).toEqual([]);
    // Outside every worktree and with no window to say what it shows, the terminal is Home's.
    expect(queued).toEqual([
      {
        message: {
          type: "open_terminal",
          data: { terminalId, cwd: root, worktreePath: null, title: "ls" },
        },
        worktreePath: null,
      },
    ]);
  });

  test("queues the terminal before its shell starts, and drops it if the shell fails", async () => {
    window = null;
    const queuedAtStart: number[] = [];
    ctx.startTerminal = async () => {
      queuedAtStart.push(queued.length);
      throw new Error("no pty");
    };

    const res = await open({ terminal: { cwd: root, command: "ls" }, queue: true });

    expect(res.status).toBe(500);
    // Queued in the tick that found no window, so one connecting while the shell starts gets it.
    expect(queuedAtStart).toEqual([1]);
    expect(queued).toEqual([]);
  });

  test("a window that connected meanwhile takes the open at once", async () => {
    window = null;
    ctx.queueForWindow = () => "sent";

    const terminal = await open({ terminal: { cwd: root }, queue: true });
    const file = await open({ filePath: join(root, "file.txt"), queue: true });

    expect(terminal.status).toBe(200);
    expect(await file.json()).toEqual({ ok: true });
  });

  test("starts no shell when the inbox is full", async () => {
    window = null;
    inboxRoom = 0;

    const res = await open({ terminal: { cwd: root, command: "ls" }, queue: true });

    expect(res.status).toBe(429);
    expect(started).toEqual([]);
  });

  test("queues a file and a page in the worktree that holds them, but not a folder", async () => {
    registerRootAsProject();
    window = null;

    const replies = [
      await open({ filePath: join(root, "file.txt"), focus: false, queue: true }),
      await open({ filePath: root, queue: true }),
      await open({ url: "https://example.com", wtPath: root, queue: true }),
    ];

    // A folder is only revealed in the window in use; with none, there is nothing to reveal later,
    // which the caller is told as final (409), not as worth retrying (503).
    expect(replies.map((res) => res.status)).toEqual([202, 409, 202]);
    expect(await replies[0]!.json()).toEqual({ ok: true, queued: true });
    expect(await replies[1]!.json()).toEqual({
      error: "No Loxel window is open to show the folder in",
    });
    expect(queued).toEqual([
      {
        message: { type: "open_file", data: { filePath: join(root, "file.txt"), focus: false } },
        worktreePath: root,
      },
      {
        message: { type: "open_url", wtPath: root, data: { url: "https://example.com" } },
        worktreePath: root,
      },
    ]);
  });

  test("a window takes the open even when the request may queue", async () => {
    const res = await open({ filePath: join(root, "file.txt"), queue: true });

    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(queued).toEqual([]);
  });

  test("rejects a queue flag that is not a boolean", async () => {
    expect((await open({ filePath: join(root, "file.txt"), queue: "yes" })).status).toBe(400);
  });

  test("opens in Home while the window shows no worktree and cwd is in none", async () => {
    window = { windowId: "w1", worktreePath: null };

    const res = await open({ terminal: { cwd: root, command: "ls" } });

    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.msg).toMatchObject({ type: "open_terminal", data: { worktreePath: null } });
    // Started with no worktree, so its shell gets no LOXEL_WORKTREE.
    expect(started).toHaveLength(1);
    expect(started[0]).not.toHaveProperty("worktreePath");
  });

  test("reports a shell that fails to start", async () => {
    ctx.startTerminal = async () => {
      throw new Error("no pty");
    };

    const res = await open({ terminal: { cwd: root, command: "ls" } });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Failed to start the terminal" });
  });

  // Regression: an agent ran `wt add` and then `loxel terminal --cwd <new worktree> '<command>'`
  // while the user was on another worktree. The command waited for the panel to attach, which
  // never happened in time, and was dropped. It must run whether or not a panel ever shows up.
  test("runs the command for a worktree created a moment ago, with no panel attached", async () => {
    const originalShell = process.env.SHELL;
    process.env.SHELL = "/bin/sh";
    const manager = new TerminalManager(new InProcessTerminalHost({ log: createNoopLogger() }), {
      isSequenceEnabled: () => false,
      onNotification: () => {},
      onExit: () => {},
      toolchainEnvs: [],
    });
    try {
      // The `wt` layout: a bare repository with its worktrees under `.worktrees`.
      const seed = join(root, "seed");
      await mkdir(seed);
      git(seed, "init", "-q", "-b", "main");
      git(
        seed,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "x",
      );
      const repo = join(root, "repo");
      git(root, "clone", "-q", "--bare", seed, repo);
      git(repo, "worktree", "add", "-q", join(repo, ".worktrees", "main"), "main");
      ctx.findProjectForPath = () => ({ cwd: repo, isBare: true }) as never;
      window = { windowId: "w1", worktreePath: join(repo, ".worktrees", "main") };
      ctx.startTerminal = ({ command, ...target }) =>
        manager.ensureSpawned(target.id, { ...target, cols: 80, rows: 24, command });

      const fresh = join(repo, ".worktrees", "feat", "new");
      git(repo, "worktree", "add", "-q", "-b", "feat/new", fresh);
      const marker = join(root, "marker");
      const res = await open({
        terminal: { cwd: fresh, command: `echo ran-$((1+1)) > ${marker}` },
        focus: false,
      });

      expect(res.status).toBe(200);
      const { terminalId, worktreePath } = sentTerminal();
      expect(worktreePath).toBe(fresh);
      expect(manager.get(terminalId)?.attached).toBe(false);
      await until(() => existsSync(marker) && readFileSync(marker, "utf8").includes("ran-2"));
    } finally {
      manager.destroyAll();
      process.env.SHELL = originalShell;
    }
  });

  test("forwards a terminal's placement, canonicalizing the group tab's path", async () => {
    const res = await open({
      terminal: { cwd: root },
      placement: { split: "right", group: { name: "file.txt", path: `${root}/./file.txt` } },
    });

    expect(res.status).toBe(200);
    expect(sentTerminal().placement).toEqual({
      split: "right",
      group: { name: "file.txt", path: join(root, "file.txt") },
    });
  });

  test("drops a group tab's path where nothing exists, keeping its name", async () => {
    await open({
      terminal: { cwd: root },
      placement: { replace: true, group: { name: "server", path: join(root, "server") } },
    });

    expect(sentTerminal().placement).toEqual({ replace: true, group: { name: "server" } });
  });

  test("forwards a file's placement and focus", async () => {
    const res = await open({
      filePath: join(root, "file.txt"),
      placement: { split: "down" },
      focus: false,
    });

    expect(res.status).toBe(200);
    expect(sent[0]!.msg).toEqual({
      type: "open_file",
      data: { filePath: join(root, "file.txt"), placement: { split: "down" }, focus: false },
    });
  });

  test("opens a folder without its placement, with a warning", async () => {
    const res = await open({ filePath: root, placement: { replace: true }, focus: true });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      warning: "Layout flags do not apply to a folder; it opens in the file tree",
    });
    expect(sent.map((s) => s.msg)).toEqual([{ type: "open_folder", data: { path: root } }]);
  });

  test("opens no folder without focus, with a warning", async () => {
    const res = await open({ filePath: root, focus: false });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      warning: "A folder is only revealed with focus; pass --focus",
    });
    expect(sent).toEqual([]);
  });

  /** Make `root` a registered project, its own only worktree. */
  function registerRootAsProject(): void {
    git(root, "init", "-q");
    ctx.findProjectForPath = () => ({ cwd: root, isBare: false }) as never;
  }

  test("sends a URL to the worktree's windows, with placement and focus only for the one in use", async () => {
    const calls: Array<{ windowId: string | null; msg: WsMessage; primary: WsMessage }> = [];
    ctx.sendToWorktreeWindows = (_wtPath, windowId, msg, primary) => {
      calls.push({ windowId, msg, primary });
      return true;
    };
    registerRootAsProject();

    const res = await open({
      url: "https://example.com",
      wtPath: root,
      windowId: "w1",
      placement: { replace: true },
    });

    expect(res.status).toBe(200);
    expect(calls).toEqual([
      {
        windowId: "w1",
        msg: { type: "open_url", wtPath: root, data: { url: "https://example.com", focus: false } },
        primary: {
          type: "open_url",
          wtPath: root,
          data: { url: "https://example.com", placement: { replace: true } },
        },
      },
    ]);
    expect(sent).toEqual([]);
  });

  test("a URL for a worktree no window shows goes to the window in use", async () => {
    registerRootAsProject();

    const res = await open({ url: "https://example.com", wtPath: root, windowId: "w1" });

    expect(res.status).toBe(200);
    expect(sent).toEqual([
      {
        windowId: "w1",
        msg: { type: "open_url", wtPath: root, data: { url: "https://example.com" } },
      },
    ]);
  });

  test("a URL waits like a file while no window is connected", async () => {
    registerRootAsProject();
    window = null;

    expect((await open({ url: "https://example.com", wtPath: root })).status).toBe(503);
  });

  test("rejects a URL for a path in no project's worktree", async () => {
    expect((await open({ url: "https://example.com", wtPath: root })).status).toBe(404);
  });

  test("a URL naming no worktree goes to the window in use, for what it shows", async () => {
    expect((await open({ url: "https://example.com" })).status).toBe(200);
    expect(sent).toEqual([
      {
        windowId: null,
        msg: { type: "open_url", wtPath: null, data: { url: "https://example.com" } },
      },
    ]);

    window = null;
    expect((await open({ url: "https://example.com" })).status).toBe(503);
  });

  test("--worktree pins a file and a terminal, and any path in the worktree names it", async () => {
    registerRootAsProject();
    await mkdir(join(root, "sub"));

    await open({ filePath: join(root, "file.txt"), pinWtPath: join(root, "sub") });
    expect(sent[0]!.msg).toEqual({
      type: "open_file",
      data: { filePath: join(root, "file.txt"), worktreePath: root },
    });

    sent = [];
    await open({ terminal: { cwd: tmpdir() }, pinWtPath: root });
    expect(sentTerminal().worktreePath).toBe(root);
  });

  test("rejects --worktree naming no project's worktree", async () => {
    const res = await open({ filePath: join(root, "file.txt"), pinWtPath: root });

    expect(res.status).toBe(404);
    expect(sent).toEqual([]);
  });

  test("commandWtPath opens a file in the worktree when it is one, and is dropped when not", async () => {
    await open({ filePath: join(root, "file.txt"), commandWtPath: root });
    registerRootAsProject();
    await open({ filePath: join(root, "file.txt"), commandWtPath: root });

    expect(sent.map((s) => s.msg)).toEqual([
      { type: "open_file", data: { filePath: join(root, "file.txt") } },
      { type: "open_file", data: { filePath: join(root, "file.txt"), worktreePath: root } },
    ]);
  });

  test("a placement batch travels with the placement", async () => {
    await open({ filePath: join(root, "file.txt"), placement: { split: "up", batch: "b" } });

    expect(sent[0]!.msg).toEqual({
      type: "open_file",
      data: { filePath: join(root, "file.txt"), placement: { split: "up", batch: "b" } },
    });
    const bad = await open({ filePath: root, placement: { batch: 1 } });
    expect(bad.status).toBe(400);
  });

  test("warns that a folder ignores --worktree", async () => {
    registerRootAsProject();

    const res = await open({ filePath: root, pinWtPath: root });

    expect(await res.json()).toEqual({
      ok: true,
      warning: "--worktree does not apply to a folder; it opens in the file tree",
    });
  });

  test("forwards a terminal's focus only when it is off", async () => {
    await open({ terminal: { cwd: root }, focus: true });
    await open({ terminal: { cwd: root }, focus: false });

    expect(sent.map((s) => s.msg.type === "open_terminal" && s.msg.data.focus)).toEqual([
      undefined,
      false,
    ]);
    expect((await open({ terminal: { cwd: root }, focus: "no" })).status).toBe(400);
  });

  test("rejects malformed placements", async () => {
    const terminal = { cwd: root };
    expect((await open({ terminal, placement: "right" })).status).toBe(400);
    expect((await open({ terminal, placement: { split: "middle" } })).status).toBe(400);
    expect((await open({ terminal, placement: { split: "up", replace: true } })).status).toBe(400);
    expect((await open({ terminal, placement: { replace: "yes" } })).status).toBe(400);
    expect((await open({ terminal, placement: { group: { name: "" } } })).status).toBe(400);
    expect((await open({ terminal, placement: { group: { name: "x", path: 1 } } })).status).toBe(
      400,
    );
    expect(sent).toEqual([]);
  });

  describe("a coding agent's terminal", () => {
    const agent = { agent: "Claude Code", terminalId: "t0", worktreePath: "/projects/app" };

    function answer(id: string, choice: string, windowId = "w1"): Promise<Response> {
      const req = new Request("http://127.0.0.1:7434/api/agent-terminals/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, answer: choice, windowId }),
      });
      return handleRequest(req, ctx);
    }

    async function clearAlways(): Promise<void> {
      const req = new Request("http://127.0.0.1:7434/api/agent-terminals/clear-always", {
        method: "POST",
      });
      expect((await handleRequest(req, ctx)).status).toBe(200);
    }

    test("runs at once with Run, and its panel says which agent started it", async () => {
      const res = await open({ terminal: { cwd: root, command: "make" }, agent });

      expect(res.status).toBe(200);
      expect(sentTerminal().origin).toEqual(agent);
      expect(started).toEqual([
        expect.objectContaining({ id: sentTerminal().terminalId, command: "make" }),
      ]);
    });

    test("is refused with Never, starting nothing", async () => {
      policy = "never";

      const res = await open({ terminal: { cwd: root, command: "make" }, agent });

      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toContain("is Never");
      expect(sent).toEqual([]);
      expect(started).toEqual([]);
    });

    test("with Ask, waits for the user's Run, then starts in the window that answered", async () => {
      policy = "ask";
      ctx.activeWindow = (id) => window && { ...window, windowId: id ?? window.windowId };

      const res = await open({
        terminal: { cwd: root, command: "make", title: "build" },
        agent,
        focus: false,
      });

      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ ok: true, asked: true });
      expect(sent).toEqual([]);
      expect(started).toEqual([]);
      const [ask] = agentState.asks;
      expect(ask).toEqual({
        id: ask!.id,
        askedAt: ask!.askedAt,
        windowId: "w1",
        origin: agent,
        cwd: root,
        worktreePath: "/projects/app",
        command: "make",
        title: "build",
      });

      expect((await answer(ask!.id, "run", "w2")).status).toBe(200);
      expect(sent[0]!.windowId).toBe("w2");
      expect(sentTerminal()).toEqual({
        terminalId: sentTerminal().terminalId,
        cwd: root,
        worktreePath: "/projects/app",
        title: "build",
        focus: false,
        origin: agent,
      });
      expect(started).toEqual([
        {
          id: sentTerminal().terminalId,
          cwd: root,
          worktreePath: "/projects/app",
          windowId: "w2",
          command: "make",
        },
      ]);
      expect(agentState.asks).toEqual([]);
      // Answered once: another window's answer finds nothing.
      expect((await answer(ask!.id, "run")).status).toBe(404);
      expect(started).toHaveLength(1);
    });

    test("with Ask, Don't Run starts nothing", async () => {
      policy = "ask";
      await open({ terminal: { cwd: root, command: "make" }, agent });

      expect((await answer(agentState.asks[0]!.id, "decline")).status).toBe(200);
      expect(agentState.asks).toEqual([]);
      expect(sent).toEqual([]);
      expect(started).toEqual([]);
    });

    test("Always in this worktree runs there from then on, and asks elsewhere", async () => {
      policy = "ask";
      await open({ terminal: { cwd: root, command: "make" }, agent });
      expect((await answer(agentState.asks[0]!.id, "always")).status).toBe(200);
      expect(started).toHaveLength(1);
      expect(agentState.alwaysWorktrees).toEqual(["/projects/app"]);

      expect((await open({ terminal: { cwd: root, command: "test" }, agent })).status).toBe(200);
      expect(started).toHaveLength(2);

      window = { windowId: "w1", worktreePath: "/projects/other" };
      expect((await open({ terminal: { cwd: root, command: "test" }, agent })).status).toBe(202);
      expect(started).toHaveLength(2);

      // Cleared in Settings, it asks again.
      window = { windowId: "w1", worktreePath: "/projects/app" };
      await clearAlways();
      expect(agentState.alwaysWorktrees).toEqual([]);
      expect((await open({ terminal: { cwd: root, command: "test" }, agent })).status).toBe(202);
      expect(started).toHaveLength(2);
    });

    test("Always in this worktree also runs the requests already waiting there", async () => {
      policy = "ask";
      await open({ terminal: { cwd: root, command: "a" }, agent });
      await open({ terminal: { cwd: root, command: "b" }, agent });
      window = { windowId: "w1", worktreePath: "/projects/other" };
      await open({ terminal: { cwd: root, command: "c" }, agent });

      expect((await answer(agentState.asks[0]!.id, "always")).status).toBe(200);

      expect(started.map((terminal) => terminal.command)).toEqual(["a", "b"]);
      expect(agentState.asks.map((ask) => ask.command)).toEqual(["c"]);
    });

    test("an answer with no window to open in leaves the request to answer again", async () => {
      policy = "ask";
      await open({ terminal: { cwd: root, command: "make" }, agent });
      const { id } = agentState.asks[0]!;
      window = null;

      expect((await answer(id, "always")).status).toBe(503);
      expect(agentState.asks).toHaveLength(1);
      expect(agentState.alwaysWorktrees).toEqual([]);
      expect(started).toEqual([]);
    });

    test("an answered request never replaces the tab the user is on by then", async () => {
      policy = "ask";
      const placement = { replace: true, group: { name: "dev" } };
      await open({ terminal: { cwd: root }, agent, placement });

      await answer(agentState.asks[0]!.id, "run");

      expect(sentTerminal().placement).toEqual({ group: { name: "dev" } });
    });

    test("Never refuses before waiting for a window", async () => {
      policy = "never";
      window = null;

      expect((await open({ terminal: { cwd: root }, agent })).status).toBe(403);
    });

    test("with Ask and no window, waits for the next window to ask in", async () => {
      policy = "ask";
      window = null;

      // Without queue the CLI retries while a window may be coming.
      expect((await open({ terminal: { cwd: root }, agent })).status).toBe(503);
      const res = await open({ terminal: { cwd: root, command: "make" }, agent, queue: true });

      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ ok: true, asked: true, queued: true });
      expect(started).toEqual([]);
      expect(queued).toEqual([]);
      const [ask] = agentState.asks;
      expect(ask?.windowId).toBeUndefined();
      // Outside every worktree and with no window to say what it shows, the terminal is Home's.
      expect(ask?.worktreePath).toBeNull();

      ctx.agentTerminals.windowConnected("w9", (windowId) => windowId === "w9");
      expect(agentState.asks[0]?.windowId).toBe("w9");
    });

    test("a person's terminal is never asked about", async () => {
      policy = "ask";
      expect((await open({ terminal: { cwd: root, command: "make" } })).status).toBe(200);
      policy = "never";
      expect((await open({ terminal: { cwd: root, command: "make" } })).status).toBe(200);

      expect(started).toHaveLength(2);
      expect(agentState.asks).toEqual([]);
    });

    test("rejects a malformed agent and answer", async () => {
      expect((await open({ terminal: { cwd: root }, agent: "claude" })).status).toBe(400);
      expect((await open({ terminal: { cwd: root }, agent: { agent: 1 } })).status).toBe(400);
      expect((await answer("x", "maybe")).status).toBe(400);
      expect(started).toEqual([]);
    });
  });
});
