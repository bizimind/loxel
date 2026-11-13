import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNoopLogger } from "@bizimind/logger";

import type { AgentOverlayServerMessage } from "@/api/agent-overlay-model";
import type { TerminalScreen } from "@/terminal-host";

import { AgentOverlayService } from "./agent-overlay-service";
import { CLAUDE_HOOK_COMMAND } from "./claude-hooks";

const FIXTURES = join(import.meta.dir, "fixtures", "claude-2.1.325");
const TERMINAL = "0b6c3c1e-7d4e-4c55-9d6b-2f1a3e4d5c6b";

function fixtureScreen(name: string): TerminalScreen {
  const lines = readFileSync(join(FIXTURES, `${name}.txt`), "utf8")
    .replace(/\n$/u, "")
    .split("\n");
  return { cols: 120, rows: lines.length, cursorX: 0, cursorY: 0, alternate: false, lines };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "agent-overlay-"));
  const transcript = join(dir, "session.jsonl");
  copyFileSync(join(FIXTURES, "transcript.jsonl"), transcript);
  const messages: AgentOverlayServerMessage[] = [];
  const writes: string[] = [];
  let screen = fixtureScreen("02-idle");
  const service = new AgentOverlayService({
    dir,
    terminals: {
      has: (id) => id === TERMINAL,
      screen: () => Promise.resolve(screen),
      write: (_id, data) => writes.push(new TextDecoder().decode(data)),
    },
    broadcastAll: (message) => messages.push(message),
    spawnEnv: () => process.env,
    log: createNoopLogger(),
    screenWatchMs: 60_000,
  });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) =>
      (await service.handle(req, new URL(req.url))) ?? new Response("", { status: 404 }),
  });
  cleanups.push(() => {
    service.dispose();
    void server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });
  /** Runs the hook command a terminal's `claude` runs, with that terminal's variables. */
  const runHook = async (
    payload: object,
    env: Record<string, string> = service.terminalEnv(TERMINAL),
  ) => {
    const proc = Bun.spawn(["/bin/sh", "-c", CLAUDE_HOOK_COMMAND], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LOXEL_PORT: String(server.port), ...env },
      stdin: new TextEncoder().encode(JSON.stringify(payload)),
      stdout: "pipe",
    });
    const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    return { exitCode, stdout };
  };
  const hook = (event: string, extra: object = {}) => ({
    hook_event_name: event,
    session_id: "11111111-2222-4333-8444-555555555555",
    transcript_path: transcript,
    cwd: dir,
    ...extra,
  });
  const sessions = () =>
    messages.flatMap((message) =>
      message.type === "agent_session" && message.session ? [message.session] : [],
    );
  return {
    service,
    messages,
    writes,
    runHook,
    hook,
    sessions,
    setScreen: (name: string) => {
      screen = fixtureScreen(name);
    },
  };
}

describe("AgentOverlayService", () => {
  test("the hook command reports to the terminal's session, prints nothing and exits 0", async () => {
    const { runHook, hook, sessions } = setup();
    const started = await runHook(hook("SessionStart", { model: "claude-haiku-5-5" }));
    expect(started).toEqual({ exitCode: 0, stdout: "" });
    await runHook(hook("UserPromptSubmit", { permission_mode: "default" }));
    await runHook(
      hook("PermissionRequest", {
        tool_name: "Bash",
        tool_input: { command: "python3 -c 'print(6*7)'" },
        permission_suggestions: [
          { type: "addRules", behavior: "allow", destination: "localSettings" },
        ],
      }),
    );
    expect(sessions().map((session) => session.state)).toEqual(["idle", "working", "needs-input"]);
    expect(sessions().at(-1)).toMatchObject({
      terminalId: TERMINAL,
      model: "claude-haiku-5-5",
      permissionMode: "default",
      interaction: { kind: "permission", toolName: "Bash" },
    });
  });

  test("hooks without the terminal's token, or outside a Loxel terminal, change nothing", async () => {
    const { runHook, hook, messages } = setup();
    const forged = await runHook(hook("Stop"), {
      LOXEL_TERMINAL_ID: TERMINAL,
      LOXEL_AGENT_TOKEN: "x",
    });
    const outside = await runHook(hook("Stop"), {});
    expect([forged.exitCode, outside.exitCode]).toEqual([0, 0]);
    expect(messages).toEqual([]);
  });

  test("a subscriber gets the transcript the hooks named", async () => {
    const { service, runHook, hook } = setup();
    await runHook(hook("SessionStart"));
    const received: AgentOverlayServerMessage[] = [];
    service.subscribe({ send: (data) => received.push(JSON.parse(data)) }, TERMINAL);
    const first = received[0];
    expect(first?.type === "agent_transcript" && first.reset).toBe(true);
    expect(
      first?.type === "agent_transcript" ? first.items.map((item) => item.kind) : [],
    ).toContain("tool");
  });

  test("a claude -p started inside the session does not take it over", async () => {
    const { runHook, hook, sessions } = setup();
    await runHook(hook("SessionStart"));
    await runHook({
      ...hook("UserPromptSubmit"),
      session_id: "child-session",
      transcript_path: "/tmp/child.jsonl",
    });
    expect(sessions().map((session) => session.sessionId)).toEqual([
      "11111111-2222-4333-8444-555555555555",
    ]);
  });

  test("an answer for an interaction another one replaced is refused, typing nothing", async () => {
    const { service, runHook, hook, writes, setScreen, sessions } = setup();
    await runHook(hook("PermissionRequest", { tool_name: "Bash", tool_input: { command: "ls" } }));
    const first = sessions().at(-1)?.interaction?.id ?? "";
    await runHook(
      hook("PermissionRequest", { tool_name: "Bash", tool_input: { command: "rm -rf x" } }),
    );
    setScreen("03-permission-bash");
    const result = await service.perform(TERMINAL, {
      type: "permission",
      interactionId: first,
      decision: "allow",
    });
    expect(result).toMatchObject({ ok: false, fallback: true });
    expect(writes).toEqual([]);
  });

  test("actions type into the terminal only when the screen is what they expect", async () => {
    const { service, runHook, hook, writes, setScreen } = setup();
    await runHook(hook("SessionStart"));
    setScreen("03-permission-bash");
    const refused = await service.perform(TERMINAL, { type: "prompt", text: "hello" });
    expect(refused).toEqual({
      ok: false,
      error: "Claude is waiting on a dialog; answer it first",
      fallback: true,
    });
    expect(writes).toEqual([]);
    const unknown = await service.perform("4f1d2c3b-0000-4000-8000-000000000000", {
      type: "interrupt",
    });
    expect(unknown.ok).toBe(false);
  });
});
