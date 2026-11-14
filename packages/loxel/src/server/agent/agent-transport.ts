import type {
  AgentEvent,
  AgentImage,
  AgentPermissionMode,
  AgentRequest,
  AgentResponse,
} from "@/api/agent-session-model";

/** Where and how a transport starts its agent. */
export interface AgentLaunch {
  /** The panel's worktree: where the agent runs, and `LOXEL_WORKTREE` in its commands. */
  worktreePath: string;
  /** The agent's session id: a new session takes it, an existing one is resumed. */
  sessionId: string;
  resume: boolean;
}

export interface AgentTransportHandlers {
  onEvents(events: readonly AgentEvent[]): void;
  /** The agent process ended; `error` says why when it was not asked to stop. */
  onExit(error: string | null): void;
}

/**
 * How {@link AgentSession} drives one agent process. Everything above it (the event model, the
 * state, the socket, the panel) is shared by every transport; a transport only translates.
 */
export interface AgentTransport {
  /** Starts the process and reports its commands and models; rejects if it cannot start. */
  start(): Promise<void>;
  send(message: {
    id: string;
    text: string;
    images: readonly AgentImage[];
    delivery: "queue" | "steer";
  }): void;
  interrupt(): Promise<void>;
  /** Answers a request the agent made; `request` is the pending one, as the state holds it. */
  respond(request: AgentRequest, response: AgentResponse): void;
  setPermissionMode(mode: AgentPermissionMode): Promise<void>;
  setModel(model: string): Promise<void>;
  setEffort(effort: string): Promise<void>;
  refreshContextUsage(): Promise<void>;
  /** Ends the process; resolves once it has exited. No `onExit` error follows. */
  stop(): Promise<void>;
}
