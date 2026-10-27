import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WsMessage } from "@/api/ws-protocol";
import { until } from "@/test/until";

import type { ActiveWindow, RouteContext } from "./routes";
import { handleRequest } from "./routes";
import { TerminalManager } from "./terminal-manager";

type StartedTerminal = Parameters<RouteContext["startTerminal"]>[0];

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

  beforeEach(async () => {
    root = realpathSync(await mkdtemp(join(tmpdir(), "loxel-open-")));
    await writeFile(join(root, "file.txt"), "x");
    sent = [];
    started = [];
    window = { windowId: "w1", worktreePath: "/projects/app" };
    ctx = {
      broadcastToSubscribers: () => {},
      broadcastToProject: () => {},
      broadcastAll: () => {},
      sendToActiveWindow: (windowId, msg) => {
        if (!window) return false;
        sent.push({ windowId, msg });
        return true;
      },
      sendToWorktreeWindows: () => {},
      externalFolderConflict: () => null,
      getProject: () => undefined,
      findProjectForPath: () => undefined,
      getWorktreeResources: () => undefined,
      suspendWorktreeWatchers: async () => async () => {},
      completeWorktreeRemoval: () => {},
      resolveFilePath: () => null,
      initializeProject: async () => ({ project: {} as never, worktrees: [] }),
      teardownProject: () => {},
      shutdown: () => {},
      resolveSchema: async () => ({}),
      updateYamlSchemas: () => {},
      updateTomlSchemas: () => {},
      formatContent: async () => ({ content: null }),
      getDetectedFormatters: () => [],
      activeWindow: () => window,
      startTerminal: async (target) => {
        started.push(target);
      },
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

  test("starts no shell while no window can take the terminal", async () => {
    window = null;

    const res = await open({ terminal: { cwd: root, command: "ls" } });

    expect(res.status).toBe(503);
    expect(started).toEqual([]);
  });

  test("waits like for a window while the window shows no worktree and cwd is in none", async () => {
    window = { windowId: "w1", worktreePath: null };

    const res = await open({ terminal: { cwd: root, command: "ls" } });

    // 503, which the CLI retries: a launching window shows its worktree in a moment.
    expect(res.status).toBe(503);
    expect(sent).toEqual([]);
    expect(started).toEqual([]);
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
    const manager = new TerminalManager({
      isSequenceEnabled: () => false,
      onNotification: () => {},
      onExit: () => {},
      pythonEnvFor: async () => null,
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

  test("sends a URL to the worktree's windows, with the placement only for the one in use", async () => {
    const calls: Array<{ windowId: string | null; msg: WsMessage; primary: WsMessage }> = [];
    ctx.sendToWorktreeWindows = (_wtPath, windowId, msg, primary) =>
      calls.push({ windowId, msg, primary });
    ctx.findProjectForPath = () => ({}) as never;

    const res = await open({
      url: "https://example.com",
      wtPath: root,
      windowId: "w1",
      placement: { replace: true },
      focus: false,
    });

    expect(res.status).toBe(200);
    expect(calls).toEqual([
      {
        windowId: "w1",
        msg: { type: "open_url", wtPath: root, data: { url: "https://example.com", focus: false } },
        primary: {
          type: "open_url",
          wtPath: root,
          data: { url: "https://example.com", placement: { replace: true }, focus: false },
        },
      },
    ]);
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
});
