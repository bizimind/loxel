/**
 * Drives the user's installed Claude Code in `--print` mode over stream-json: user messages and
 * control requests go in on stdin, messages and control requests come out on stdout, one JSON
 * object per line. See docs/AGENT_PANEL.md for the protocol subset Loxel speaks and how it degrades.
 */
import {
  type AgentPermissionMode,
  type AgentRequest,
  type AgentResponse,
  isAgentPermissionMode,
} from "@/api/agent-session-model";
import { withoutAgentEnv } from "@/coding-agent-env";
import { isRecord } from "@/lib/is-record";

import { logger } from "../logger";
import type { AgentLaunch, AgentTransport, AgentTransportHandlers } from "./agent-transport";
import {
  ClaudeStreamNormalizer,
  initialStatus,
  parseCommands,
  parseModels,
  parsePermissionRequest,
} from "./claude-stream-normalizer";

const log = logger.child("agent");

/** A started agent process, as the transport needs it; tests replace it with a recording. */
export interface StreamProcess {
  writeLine(line: string): void;
  /** Closes stdin, which ends a print-mode session once its current turn settles. */
  endInput(): void;
  readonly lines: AsyncIterable<string>;
  readonly exited: Promise<number>;
  /** The end of what the process wrote to stderr, for the error shown when it fails. */
  stderrTail(): string;
  kill(signal?: "SIGTERM" | "SIGKILL"): void;
}

export type StreamProcessFactory = (args: readonly string[], launch: AgentLaunch) => StreamProcess;

/** How long a control request may take before the transport gives up on it. */
const CONTROL_TIMEOUT_MS = 30_000;
const STDERR_TAIL_BYTES = 4096;
/** How long `stop()` waits for the process to exit after closing stdin before killing it. */
const STOP_GRACE_MS = 3000;
/** How long `stop()` waits for the interrupt it sends first. */
const STOP_INTERRUPT_MS = 2000;

/** The CLI arguments for a launch. The model, mode and effort come from the user's settings. */
export function claudeStreamArgs(launch: AgentLaunch): string[] {
  return [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    // Hidden flag: permission prompts come to this side as can_use_tool control requests. Without
    // a prompt handler the CLI also leaves out AskUserQuestion and the plan mode tools.
    "--permission-prompt-tool",
    "stdio",
    "--include-partial-messages",
    // Echo each user message once the CLI takes it, which is when a queued one is delivered.
    "--replay-user-messages",
    ...(launch.resume ? ["--resume", launch.sessionId] : ["--session-id", launch.sessionId]),
  ];
}

async function* splitLines(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      yield buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  }
  if (buffer) yield buffer;
}

/** Spawns `claude` with Loxel's spawn environment, minus any agent session it runs inside. */
export function spawnClaudeProcess(
  binary: string,
  env: Record<string, string | undefined>,
  loxelEnv: Record<string, string>,
): StreamProcessFactory {
  return (args, launch) => {
    const proc = Bun.spawn([binary, ...args], {
      cwd: launch.worktreePath,
      env: { ...withoutAgentEnv(env), ...loxelEnv, LOXEL_WORKTREE: launch.worktreePath },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    let stderr = "";
    void (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of proc.stderr) {
        stderr = (stderr + decoder.decode(chunk, { stream: true })).slice(-STDERR_TAIL_BYTES);
      }
    })().catch(() => {});
    return {
      writeLine: (line) => {
        proc.stdin.write(`${line}\n`);
        // A process that just exited fails the flush; its exit is reported on its own.
        Promise.resolve(proc.stdin.flush()).catch(() => {});
      },
      endInput: () => {
        Promise.resolve(proc.stdin.end()).catch(() => {});
      },
      lines: splitLines(proc.stdout),
      exited: proc.exited,
      stderrTail: () => stderr,
      kill: (signal) => proc.kill(signal),
    };
  };
}

interface PendingControl {
  resolve(response: Record<string, unknown>): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** The `can_use_tool` answer for the user's response to a pending request. */
export function permissionResult(
  request: AgentRequest,
  response: AgentResponse,
): Record<string, unknown> {
  if (response.kind === "question" && request.kind === "question") {
    return { behavior: "allow", updatedInput: { ...request.input, answers: response.answers } };
  }
  if (response.kind === "plan" && request.kind === "plan") {
    if (!response.approve) {
      return {
        behavior: "deny",
        message: response.feedback?.trim() || "The user wants to keep planning.",
      };
    }
    return {
      behavior: "allow",
      updatedInput: request.input,
      ...(response.mode
        ? { updatedPermissions: [{ type: "setMode", mode: response.mode, destination: "session" }] }
        : {}),
    };
  }
  if (response.kind === "permission" && response.allow && request.kind === "permission") {
    // Only the agent's own suggestions, rebuilt from the request this side holds.
    const updates = request.suppressAlwaysAllow
      ? []
      : (response.alwaysAllow ?? []).flatMap(({ index, destination }) => {
          const suggestion = request.suggestions[index];
          return suggestion ? [{ ...suggestion.update, destination }] : [];
        });
    return {
      behavior: "allow",
      updatedInput: request.input,
      ...(updates.length > 0 ? { updatedPermissions: updates } : {}),
    };
  }
  return {
    behavior: "deny",
    message: (response.kind === "permission" && response.message?.trim()) || "The user declined.",
  };
}

export class ClaudeStreamTransport implements AgentTransport {
  private process: StreamProcess | null = null;
  private readonly normalizer = new ClaudeStreamNormalizer();
  private readonly pendingControl = new Map<string, PendingControl>();
  private nextRequestId = 0;
  private stopping = false;
  /** Settles once everything the process wrote to stdout has been handled. */
  private drained: Promise<void> = Promise.resolve();

  constructor(
    private readonly launch: AgentLaunch,
    private readonly spawn: StreamProcessFactory,
    private readonly handlers: AgentTransportHandlers,
  ) {}

  async start(): Promise<void> {
    const proc = this.spawn(claudeStreamArgs(this.launch), this.launch);
    this.process = proc;
    this.drained = this.readLoop(proc).catch((err: unknown) => {
      log.warn("Reading the agent's output failed", { error: err });
    });
    // The exit is reported once the output before it has been handled: a final result or error
    // frame can still be in the pipe when the process ends.
    void Promise.all([proc.exited, this.drained]).then(([code]) => this.exited(proc, code));
    // No systemPrompt: the CLI then uses Claude Code's own prompt, as in the terminal.
    const response = await this.request({ subtype: "initialize", hooks: {} });
    this.handlers.onEvents([
      {
        type: "catalog",
        commands: parseCommands(response.commands),
        models: parseModels(response.models),
      },
      { type: "status", status: initialStatus(response) },
      // The mode the user's settings start in; the init message only comes with the first turn.
      ...(isAgentPermissionMode(response.current_permission_mode)
        ? [{ type: "permission_mode" as const, mode: response.current_permission_mode }]
        : []),
    ]);
  }

  send({ id, text, images, delivery }: Parameters<AgentTransport["send"]>[0]): void {
    this.normalizer.noteSent(id);
    const content = [
      ...images.map((image) => ({
        type: "image",
        source: { type: "base64", media_type: image.mediaType, data: image.data },
      })),
      ...(text ? [{ type: "text", text }] : []),
    ];
    this.write({
      type: "user",
      uuid: id,
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: this.launch.sessionId,
      // `now` folds the message into the running turn; `next` waits for it to finish.
      priority: delivery === "steer" ? "now" : "next",
      origin: { kind: "human" },
    });
  }

  async interrupt(): Promise<void> {
    await this.request({ subtype: "interrupt" });
  }

  respond(request: AgentRequest, response: AgentResponse): void {
    // Resolved first: the CLI's answer to it may already be on its way.
    this.handlers.onEvents([{ type: "request_resolved", requestId: request.requestId }]);
    this.write({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: request.requestId,
        response: permissionResult(request, response),
      },
    });
  }

  async setPermissionMode(mode: AgentPermissionMode): Promise<void> {
    await this.request({ subtype: "set_permission_mode", mode });
    this.handlers.onEvents([{ type: "permission_mode", mode }]);
  }

  async setModel(model: string): Promise<void> {
    await this.request({ subtype: "set_model", model });
    this.handlers.onEvents([{ type: "model", model }]);
  }

  async setEffort(effort: string): Promise<void> {
    await this.request({ subtype: "apply_flag_settings", settings: { effortLevel: effort } });
    this.handlers.onEvents([{ type: "effort", effort }]);
  }

  async refreshContextUsage(): Promise<void> {
    const usage = await this.request({ subtype: "get_context_usage", detail: "summary" });
    const { percentage, totalTokens, maxTokens } = usage;
    if (
      typeof percentage !== "number" ||
      typeof totalTokens !== "number" ||
      typeof maxTokens !== "number"
    ) {
      return;
    }
    this.handlers.onEvents([
      { type: "context_usage", usage: { percentage, totalTokens, maxTokens } },
    ]);
  }

  async stop(): Promise<void> {
    const proc = this.process;
    if (!proc) return;
    this.stopping = true;
    // A running turn would hold the process up, so interrupt it before closing stdin. Then
    // SIGTERM, and SIGKILL for a process that ignores it.
    await Promise.race([this.interrupt().catch(() => {}), Bun.sleep(STOP_INTERRUPT_MS)]);
    proc.endInput();
    const term = setTimeout(() => proc.kill("SIGTERM"), STOP_GRACE_MS);
    const kill = setTimeout(() => proc.kill("SIGKILL"), STOP_GRACE_MS * 2);
    await proc.exited;
    clearTimeout(term);
    clearTimeout(kill);
    await this.drained;
  }

  private write(frame: Record<string, unknown>): void {
    if (!this.process) throw new Error("The agent process is not running");
    this.process.writeLine(JSON.stringify(frame));
  }

  private request(inner: Record<string, unknown>): Promise<Record<string, unknown>> {
    const requestId = `loxel_${++this.nextRequestId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingControl.delete(requestId);
        reject(new Error(`Claude Code did not answer ${String(inner.subtype)} in time`));
      }, CONTROL_TIMEOUT_MS);
      this.pendingControl.set(requestId, { resolve, reject, timer });
      try {
        this.write({ type: "control_request", request_id: requestId, request: inner });
      } catch (err) {
        clearTimeout(timer);
        this.pendingControl.delete(requestId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private async readLoop(proc: StreamProcess): Promise<void> {
    for await (const line of proc.lines) {
      if (!line.trim()) continue;
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch {
        // stdout carries only JSON in stream-json mode; anything else is noise from a wrapper.
        continue;
      }
      this.handleFrame(frame);
    }
  }

  /** Exposed for the replay tests, which feed recorded frames without a process. */
  handleFrame(frame: unknown): void {
    if (!isRecord(frame)) return;
    if (frame.type === "control_response") return this.controlResponse(frame);
    if (frame.type === "control_request") return this.controlRequest(frame);
    if (frame.type === "control_cancel_request") {
      const requestId = typeof frame.request_id === "string" ? frame.request_id : null;
      if (requestId) this.handlers.onEvents([{ type: "request_resolved", requestId }]);
      return;
    }
    const events = this.normalizer.normalize(frame);
    if (events.length > 0) this.handlers.onEvents(events);
  }

  private controlResponse(frame: Record<string, unknown>): void {
    const response = isRecord(frame.response) ? frame.response : null;
    const requestId = typeof response?.request_id === "string" ? response.request_id : null;
    const pending = requestId ? this.pendingControl.get(requestId) : undefined;
    if (!response || !requestId || !pending) return;
    this.pendingControl.delete(requestId);
    clearTimeout(pending.timer);
    if (response.subtype === "success") {
      pending.resolve(isRecord(response.response) ? response.response : {});
    } else {
      pending.reject(new Error(typeof response.error === "string" ? response.error : "Failed"));
    }
  }

  private controlRequest(frame: Record<string, unknown>): void {
    const requestId = typeof frame.request_id === "string" ? frame.request_id : null;
    const request = isRecord(frame.request) ? frame.request : null;
    if (!requestId || !request) return;
    if (request.subtype === "can_use_tool") {
      const parsed = parsePermissionRequest(requestId, request);
      if (parsed) {
        this.handlers.onEvents([{ type: "request", request: parsed }]);
        return;
      }
    }
    if (request.subtype === "elicitation") {
      // MCP servers asking for input get "decline" until the panel can render their forms; the
      // terminal can answer them.
      this.write({
        type: "control_response",
        response: { subtype: "success", request_id: requestId, response: { action: "decline" } },
      });
      this.handlers.onEvents([
        {
          type: "item",
          item: {
            kind: "notice",
            id: `elicitation-${requestId}`,
            level: "info",
            text: "An MCP server asked for input, which this panel cannot show yet. Continue in a terminal to answer it.",
          },
        },
      ]);
      return;
    }
    // Requests this side does not implement (hook callbacks, dialogs it never declared) get an
    // error, which the CLI treats as "not handled here".
    this.write({
      type: "control_response",
      response: {
        subtype: "error",
        request_id: requestId,
        error: `Loxel does not handle ${String(request.subtype)}`,
      },
    });
  }

  private exited(proc: StreamProcess, code: number): void {
    if (this.process !== proc) return;
    this.process = null;
    for (const pending of this.pendingControl.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("The agent process exited"));
    }
    this.pendingControl.clear();
    if (this.stopping) {
      this.handlers.onExit(null);
      return;
    }
    const tail = proc.stderrTail().trim();
    this.handlers.onExit(
      code === 0 ? null : `Claude Code exited with code ${code}${tail ? `: ${tail}` : ""}`,
    );
  }
}
