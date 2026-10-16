import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WsMessage } from "@/api/ws-protocol";

import type { RouteContext } from "./routes";
import { handleRequest } from "./routes";

describe("POST /api/open terminal requests", () => {
  let root: string;
  let ctx: RouteContext;
  let sent: Array<{ windowId: string | null; msg: WsMessage }>;
  let commands: Array<{ terminalId: string; command: string }>;
  let windowConnected: boolean;

  beforeEach(async () => {
    root = realpathSync(await mkdtemp(join(tmpdir(), "loxel-open-")));
    await writeFile(join(root, "file.txt"), "x");
    sent = [];
    commands = [];
    windowConnected = true;
    ctx = {
      broadcastToSubscribers: () => {},
      broadcastToProject: () => {},
      broadcastAll: () => {},
      sendToActiveWindow: (windowId, msg) => {
        sent.push({ windowId, msg });
        return windowConnected;
      },
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
      formatContent: async () => null,
      getDetectedFormatters: () => [],
      setTerminalCommand: (terminalId, command) => commands.push({ terminalId, command }),
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

  test("sends the window a terminal to create and holds the command for the attach", async () => {
    const res = await open({
      terminal: { cwd: root, command: "claude 'do it'", title: "claude" },
      windowId: "w1",
    });

    expect(res.status).toBe(200);
    const data = sentTerminal();
    expect(sent[0]!.windowId).toBe("w1");
    expect(data).toEqual({ terminalId: data.terminalId, cwd: root, title: "claude" });
    expect(commands).toEqual([{ terminalId: data.terminalId, command: "claude 'do it'" }]);
    expect(await res.json()).toEqual({ ok: true, terminalId: data.terminalId });
  });

  test("a terminal without a command registers nothing and carries no title", async () => {
    const res = await open({ terminal: { cwd: root } });

    expect(res.status).toBe(200);
    expect(sentTerminal()).toEqual({ terminalId: sentTerminal().terminalId, cwd: root });
    expect(sent[0]!.windowId).toBeNull();
    expect(commands).toEqual([]);
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
    expect(commands).toEqual([]);
  });

  test("rejects malformed terminal bodies", async () => {
    expect((await open({ terminal: "x" })).status).toBe(400);
    expect((await open({ terminal: {} })).status).toBe(400);
    expect((await open({ terminal: { cwd: root, command: 1 } })).status).toBe(400);
    expect((await open({ terminal: { cwd: root, title: [] } })).status).toBe(400);
    expect(sent).toEqual([]);
  });

  test("does not hold the command while no window can take the terminal", async () => {
    windowConnected = false;

    const res = await open({ terminal: { cwd: root, command: "ls" } });

    expect(res.status).toBe(503);
    expect(commands).toEqual([]);
  });
});
