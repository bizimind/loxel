/**
 * The boundary between an agent session and the process that runs the agent. A transport starts
 * the agent, feeds it user messages and control calls, and reports what the agent does as
 * {@link AgentUpdate}s; the session owns everything the UI sees. The Agent SDK transport
 * (`claude-sdk-transport.ts`) is one implementation; a raw stream-json client or a terminal-hosted
 * process could be another without touching the session or the renderer.
 */
import type {
  AgentDelivery,
  AgentEffort,
  AgentImage,
  AgentPermissionMode,
} from "@/api/agent-session-model";

import type { AgentUpdate } from "./claude-message-translator";
import type { ClaudePermissionResult, ClaudeToolRequest } from "./claude-permissions";

export interface AgentTransportSink {
  update(update: AgentUpdate): void;
  /** The agent wants to run a tool that needs the user; resolves with the user's decision. */
  requestTool(request: ClaudeToolRequest, signal: AbortSignal): Promise<ClaudePermissionResult>;
  /** The agent process ended: `error` is why, or null for a clean end (closed by the session). */
  exit(error: string | null): void;
}

export interface AgentOutgoingMessage {
  /** Echoed back in `user_delivered` once the agent takes the message in. */
  uuid: string;
  text: string;
  images: AgentImage[];
  delivery: AgentDelivery;
}

export interface AgentTransport {
  send(message: AgentOutgoingMessage): void;
  interrupt(): Promise<void>;
  setModel(model: string): Promise<void>;
  setEffort(effort: AgentEffort): Promise<void>;
  setPermissionMode(mode: AgentPermissionMode): Promise<void>;
  /**
   * Stop the agent process. The sink gets no further updates. Resolves once the process has ended,
   * so nothing else (a `claude --resume` in a terminal) writes the session while it still does.
   */
  close(): Promise<void>;
}

export interface AgentTransportStartOptions {
  cwd: string;
  /** Continue this saved session instead of starting a new one. */
  resumeSessionId?: string;
  sink: AgentTransportSink;
}

export interface AgentBackend {
  start(options: AgentTransportStartOptions): Promise<AgentTransport>;
  /** A saved session's messages, oldest first, in the shape the translator reads. */
  loadHistory(sessionId: string, cwd: string): Promise<unknown[]>;
}
