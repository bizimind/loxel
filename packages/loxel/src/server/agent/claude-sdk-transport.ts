/**
 * Runs Claude Code through the Claude Agent SDK: one long-lived streaming `query()` per session,
 * spawning the user's own installed `claude` with their settings, CLAUDE.md, skills, plugins and
 * MCP servers. See `agent-transport.ts` for the contract.
 */
import {
  getSessionMessages,
  query,
  type CanUseTool,
  type PermissionMode,
  type PermissionResult,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import {
  isEffort,
  isPermissionMode,
  type AgentEffort,
  type AgentModel,
  type AgentSessionInfo,
} from "@/api/agent-session-model";
import { CODING_AGENT_ENV_VARS } from "@/coding-agent-env";

import { logger } from "../logger";
import { buildSpawnEnv, refreshLoginShellEnv } from "../shell-env";
import type {
  AgentBackend,
  AgentOutgoingMessage,
  AgentTransport,
  AgentTransportStartOptions,
} from "./agent-transport";
import { ClaudeMessageTranslator, parseCommands } from "./claude-message-translator";
import type { ClaudePermissionUpdate, ClaudeToolRequest } from "./claude-permissions";

const log = logger.child("agent");

/** User messages waiting for the SDK to read them; the SDK's streaming-input prompt. */
class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private readonly pending: SDKUserMessage[] = [];
  private waiting: ((result: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  push(message: SDKUserMessage): void {
    if (this.closed) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: message, done: false });
      return;
    }
    this.pending.push(message);
  }

  close(): void {
    this.closed = true;
    this.waiting?.({ value: undefined, done: true });
    this.waiting = null;
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const next = this.pending.shift();
        if (next) return Promise.resolve({ value: next, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}

/** The user's `claude` on the login-shell PATH, refreshing the captured PATH once on a miss. */
export async function findClaudeExecutable(): Promise<string | null> {
  const lookup = () => Bun.which("claude", { PATH: buildSpawnEnv().PATH ?? "" });
  const found = lookup();
  if (found) return found;
  await refreshLoginShellEnv();
  return lookup();
}

function agentEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(buildSpawnEnv())) {
    if (value !== undefined) env[name] = value;
  }
  // A Loxel started from an agent's session must not make the agent think it runs inside one.
  for (const name of CODING_AGENT_ENV_VARS) delete env[name];
  return env;
}

function toModels(models: readonly unknown[]): AgentModel[] {
  return models.flatMap((model) => {
    if (typeof model !== "object" || model === null) return [];
    const { value, resolvedModel, displayName, description, supportedEffortLevels } =
      model as Record<string, unknown>;
    if (typeof value !== "string") return [];
    return [
      {
        value,
        ...(typeof resolvedModel === "string" ? { resolvedModel } : {}),
        displayName: typeof displayName === "string" ? displayName : value,
        description: typeof description === "string" ? description : "",
        effortLevels: Array.isArray(supportedEffortLevels)
          ? supportedEffortLevels.filter(isEffort)
          : [],
      },
    ];
  });
}

function toUserMessage({ uuid, text, images, delivery }: AgentOutgoingMessage): SDKUserMessage {
  const content = [
    ...images.map((image) => ({
      type: "image" as const,
      source: { type: "base64" as const, media_type: image.mediaType, data: image.data },
    })),
    ...(text ? [{ type: "text" as const, text }] : []),
  ];
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    uuid: uuid as SDKUserMessage["uuid"],
    origin: { kind: "human" },
    // Steering reaches the agent at its next step; a queued message waits for the turn to end.
    priority: delivery === "steer" ? "next" : "later",
  };
}

class ClaudeSdkTransport implements AgentTransport {
  private closed = false;
  /** Settles when the SDK's message stream ends, which it does once the CLI has exited. */
  finished: Promise<void> = Promise.resolve();

  constructor(
    private readonly q: Query,
    private readonly input: MessageQueue,
  ) {}

  send(message: AgentOutgoingMessage): void {
    this.input.push(toUserMessage(message));
  }

  async interrupt(): Promise<void> {
    await this.q.interrupt();
  }

  async setModel(model: string): Promise<void> {
    await this.q.setModel(model);
  }

  async setEffort(effort: AgentEffort): Promise<void> {
    await this.q.applyFlagSettings({ effortLevel: effort });
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await this.q.setPermissionMode(mode);
  }

  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.input.close();
      this.q.close();
    }
    return this.finished;
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

function toToolRequest(
  toolName: string,
  input: Record<string, unknown>,
  options: Parameters<CanUseTool>[2],
): ClaudeToolRequest {
  return {
    toolName,
    input,
    // The SDK's PermissionUpdate is the same JSON the CLI sends; declared locally for other transports.
    suggestions: (options.suggestions ?? []) as ClaudePermissionUpdate[],
    title: options.title,
    description: options.description,
    decisionReason: options.decisionReason,
    blockedPath: options.blockedPath,
    suppressAlwaysAllowRule: options.suppressAlwaysAllowRule,
  };
}

export const claudeSdkBackend: AgentBackend = {
  async start({ cwd, resumeSessionId, sink }: AgentTransportStartOptions): Promise<AgentTransport> {
    const executable = await findClaudeExecutable();
    if (!executable) {
      throw new Error(
        "Claude Code is not installed: no `claude` on your login shell's PATH. Install it, then reopen this panel.",
      );
    }

    const input = new MessageQueue();
    const translator = new ClaudeMessageTranslator();
    const canUseTool: CanUseTool = async (toolName, toolInput, options) =>
      (await sink.requestTool(
        toToolRequest(toolName, toolInput, options),
        options.signal,
      )) as PermissionResult;

    const q = query({
      prompt: input,
      options: {
        cwd,
        pathToClaudeCodeExecutable: executable,
        env: agentEnv(),
        // Without the preset the SDK sends an empty system prompt, unlike the TUI.
        systemPrompt: { type: "preset", preset: "claude_code" },
        // Without a handler AskUserQuestion and the plan-mode tools are left out of the toolset.
        canUseTool,
        includePartialMessages: true,
        // Echo user messages as the agent takes them in, so queued messages can be marked sent.
        extraArgs: { "replay-user-messages": null },
        ...(resumeSessionId ? { resume: resumeSessionId } : {}),
        stderr: (data) => log.debug("claude stderr", { data: data.slice(0, 2000) }),
      },
    });
    const transport = new ClaudeSdkTransport(q, input);

    void q
      .initializationResult()
      .then((init) => {
        const patch: Partial<AgentSessionInfo> = {
          commands: parseCommands(init.commands),
          models: toModels(init.models),
        };
        const mode: unknown = (init as Record<string, unknown>).current_permission_mode;
        if (isPermissionMode(mode)) patch.permissionMode = mode;
        sink.update({ type: "info", patch });
      })
      .catch((err: unknown) => log.warn("Agent initialization failed", { error: err }));

    transport.finished = (async () => {
      try {
        for await (const message of q) {
          for (const update of translator.translate(message)) sink.update(update);
        }
        if (!transport.isClosed) sink.exit("Claude Code exited.");
      } catch (err) {
        if (transport.isClosed) return;
        log.warn("Agent process failed", { error: err });
        sink.exit(err instanceof Error ? err.message : String(err));
      }
    })();

    return transport;
  },

  async loadHistory(sessionId: string, cwd: string): Promise<unknown[]> {
    return getSessionMessages(sessionId, { dir: cwd });
  },
};
