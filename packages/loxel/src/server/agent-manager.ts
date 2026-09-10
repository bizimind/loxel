/**
 * Coding agent session management for loxel.
 *
 * Uses the high-level `Session` API from the coding-agent SDK.
 * Bridges typed SessionEvents back to AgentEventPayload for WS forwarding
 * so the client-side processProtocolEvent() continues to work unchanged.
 */
import {
  Session,
  type SessionConfig,
  type SessionEventHandlers,
  protocolRequestSchema,
} from "@bizimind/coding-agent";

import type { AgentEventPayload, AgentSessionOptions, AgentStatus } from "@/api/ws-protocol";
import { deriveAgentStatus } from "@/api/ws-protocol";

import { logger } from "./logger";
import { buildSpawnEnv } from "./shell-env";
import { stress } from "./stress-detector";

const log = logger.child("agent");

/** Max events kept in-memory per session for replay on reattach. */
const MAX_EVENT_BUFFER = 5000;

type EventCallback = (id: string, event: AgentEventPayload, seq: number) => void;
type ExitCallback = (id: string, code: number) => void;

interface BufferedEvent {
  event: AgentEventPayload;
  seq: number;
}

interface AgentSession {
  id: string;
  codingAgentSessionId: string | null;
  scopeKey: string;
  session: Session | null;
  sessionReady: Promise<Session>;
  abortController: AbortController | null;
  /** Stored respond() callbacks for pending approvals and human-input questions. */
  respondCallbacks: Map<string, (...args: unknown[]) => void>;
  eventBuffer: BufferedEvent[];
  eventSeq: number;
  status: AgentStatus;
  workspaceRoot: string;
  hasError: boolean;
  /** Mutable callback — updated on reattach, cleared on detach. */
  onEvent: EventCallback | null;
  /** Mutable callback — updated on reattach, cleared on detach. */
  onExit: ExitCallback | null;
}

export class AgentManager {
  private sessions = new Map<string, AgentSession>();
  private scopeIndex = new Map<string, Set<string>>();

  /** Reconnect a WS client to an existing in-process session: replay buffered events and wire live forwarding. */
  reconnectClient(id: string, onEvent: EventCallback, onExit: ExitCallback): boolean {
    const existing = this.sessions.get(id);
    if (!existing) return false;

    log.info(
      `Reconnecting client to session ${id.slice(0, 8)} (${existing.eventBuffer.length} buffered events)`,
    );
    for (const { event, seq } of existing.eventBuffer) {
      onEvent(id, event, seq);
    }
    existing.onEvent = onEvent;
    existing.onExit = onExit;
    return true;
  }

  /** Create a new agent session and send session.start. */
  create(
    id: string,
    options: { workspaceRoot: string; scopeKey: string; sessionOptions?: AgentSessionOptions },
    onEvent: EventCallback,
    onExit: ExitCallback,
  ): void {
    const config = this.buildSessionConfig(id, options);
    const readyPromise = Session.create(config);
    const agentSession = this.registerSession(id, options, readyPromise, onEvent, onExit);

    readyPromise
      .then((session) => {
        agentSession.session = session;
        agentSession.codingAgentSessionId = session.id;
      })
      .catch((err: unknown) => {
        log.error(`Failed to create agent session ${id.slice(0, 8)}`, { error: err });
        agentSession.hasError = true;
        agentSession.status = "exited";
        agentSession.onExit?.(id, 1);
      });
  }

  /** Create a new agent session that resumes a forked coding-agent session. */
  createFromFork(
    id: string,
    options: {
      workspaceRoot: string;
      scopeKey: string;
      sessionOptions?: AgentSessionOptions;
      forkedSessionId: string;
      forkPointMessageId?: string;
    },
    onEvent: EventCallback,
    onExit: ExitCallback,
  ): void {
    const config = this.buildSessionConfig(id, options);
    const readyPromise = Session.resume(options.forkedSessionId, config).then(async (session) => {
      if (options.forkPointMessageId) {
        await session.rewind(options.forkPointMessageId);
      }
      return session;
    });
    const agentSession = this.registerSession(
      id,
      { ...options, codingAgentSessionId: options.forkedSessionId },
      readyPromise,
      onEvent,
      onExit,
    );

    readyPromise
      .then((session) => {
        agentSession.session = session;
        agentSession.codingAgentSessionId = session.id;
      })
      .catch((err: unknown) => {
        log.error(`Failed to resume forked session ${id.slice(0, 8)}`, { error: err });
        agentSession.hasError = true;
        agentSession.status = "exited";
        agentSession.onExit?.(id, 1);
      });
  }

  /** Forward a protocol request to the agent session. Validates at the WS boundary. */
  sendRequest(id: string, request: Record<string, unknown>): boolean {
    const agentSession = this.sessions.get(id);
    if (!agentSession || agentSession.status === "exited") return false;

    const parsed = protocolRequestSchema.safeParse(request);
    if (!parsed.success) {
      log.error(`Invalid protocol request for agent ${id.slice(0, 8)}`, {
        error: parsed.error.message,
      });
      return false;
    }
    const req = parsed.data;

    switch (req.type) {
      case "session.input": {
        const text = req.messages?.[0]?.content ?? "";
        const content = typeof text === "string" ? text : JSON.stringify(text);

        // Create a new AbortController for this send
        const controller = new AbortController();
        agentSession.abortController = controller;

        agentSession.sessionReady
          .then((session) =>
            session.send(content, { signal: controller.signal, modelProfile: req.model_profile }),
          )
          .catch((err: unknown) => {
            // Cancellation errors are expected
            if (err instanceof Error && err.message === "Run cancelled") return;
            log.error(`Agent ${id.slice(0, 8)} send failed`, { error: err });
          })
          .finally(() => {
            if (agentSession.abortController === controller) {
              agentSession.abortController = null;
            }
          });
        break;
      }

      case "session.cancel": {
        if (agentSession.abortController) {
          agentSession.abortController.abort();
          agentSession.abortController = null;
        }
        break;
      }

      case "session.compact": {
        agentSession.sessionReady
          .then((session) => session.compact())
          .catch((err: unknown) => {
            log.error(`Agent ${id.slice(0, 8)} compact failed`, { error: err });
          });
        break;
      }

      case "session.resume": {
        if (req.rewind_to_message_id) {
          // Cancel current run if active
          if (agentSession.abortController) {
            agentSession.abortController.abort();
            agentSession.abortController = null;
          }
          // Clear respond callbacks since pending interactions are invalidated
          agentSession.respondCallbacks.clear();

          const rewindId = req.rewind_to_message_id;
          agentSession.sessionReady
            .then((session) => session.rewind(rewindId))
            .catch((err: unknown) => {
              log.error(`Agent ${id.slice(0, 8)} rewind failed`, { error: err });
            });
        }
        break;
      }

      case "session.fork": {
        const messageId = req.message_id;
        agentSession.sessionReady
          .then((session) => session.fork(messageId))
          .then((forkedSession) => {
            // Emit a forked event so the client can open a new tab
            const forkedEvent: AgentEventPayload = {
              type: "session.forked",
              session_id: forkedSession.id,
              timestamp: new Date().toISOString(),
              payload: {
                session_id: forkedSession.id,
                parent_session_id: agentSession.codingAgentSessionId ?? "",
                fork_point_message_id: messageId ?? null,
              },
            };
            this.handleEvent(agentSession, forkedEvent);
            // Clean up the forked session — the client will create a new AgentSession for it
            forkedSession.destroy();
          })
          .catch((err: unknown) => {
            log.error(`Agent ${id.slice(0, 8)} fork failed`, { error: err });
          });
        break;
      }

      case "session.get": {
        agentSession.sessionReady
          .then((session) => session.getRecord())
          .catch((err: unknown) => {
            log.error(`Agent ${id.slice(0, 8)} get failed`, { error: err });
          });
        break;
      }

      case "approval.response": {
        const pendingKey = req.pending_key ?? "";
        const respond = agentSession.respondCallbacks.get(pendingKey);
        if (respond) {
          respond(req.decision);
          agentSession.respondCallbacks.delete(pendingKey);
        } else {
          log.warn(`No pending approval for key ${pendingKey} in agent ${id.slice(0, 8)}`);
        }
        break;
      }

      case "human.input.response": {
        const pendingKey = req.pending_key ?? "";
        const respond = agentSession.respondCallbacks.get(pendingKey);
        if (respond) {
          respond(req.answers ?? {}, req.freeform ?? {});
          agentSession.respondCallbacks.delete(pendingKey);
        } else {
          log.warn(`No pending question for key ${pendingKey} in agent ${id.slice(0, 8)}`);
        }
        break;
      }

      case "session.start":
      case "session.close":
      case "session.list":
        // These are handled at session creation/destruction, not via sendRequest
        break;

      default: {
        const _exhaustive: never = req;
        throw new Error(`Unknown protocol request type: ${String(_exhaustive)}`);
      }
    }

    return true;
  }

  /** Return all sessions for a given project+worktree scope. */
  getSessionsByScope(
    scopeKey: string,
  ): Array<{ id: string; status: string; codingAgentSessionId: string | null }> {
    const ids = this.scopeIndex.get(scopeKey);
    if (!ids) return [];
    const result: Array<{ id: string; status: string; codingAgentSessionId: string | null }> = [];
    for (const id of ids) {
      const session = this.sessions.get(id);
      if (session) {
        result.push({
          id: session.id,
          status: session.status,
          codingAgentSessionId: session.codingAgentSessionId,
        });
      }
    }
    return result;
  }

  getSession(id: string): AgentSession | undefined {
    return this.sessions.get(id);
  }

  /** Returns true if any sessions exist without callbacks (detached/orphaned). */
  hasOrphanSessions(): boolean {
    for (const session of this.sessions.values()) {
      if (!session.onEvent) return true;
    }
    return false;
  }

  /** Detach client callbacks. Session keeps running, events keep buffering. */
  detach(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    log.debug(`Detaching agent session ${id.slice(0, 8)}`);
    session.onEvent = null;
    session.onExit = null;
  }

  /** Destroy the agent session. */
  async destroy(id: string): Promise<void> {
    const agentSession = this.sessions.get(id);
    if (!agentSession) return;

    log.info(`Destroying agent session ${id.slice(0, 8)}`);
    this.removeFromIndex(agentSession);

    // Cancel any active run
    if (agentSession.abortController) {
      agentSession.abortController.abort();
      agentSession.abortController = null;
    }

    // Clear pending callbacks
    agentSession.respondCallbacks.clear();

    // Destroy the Session
    if (agentSession.session) {
      agentSession.session.destroy();
    } else {
      // If session hasn't resolved yet, wait for it and destroy
      agentSession.sessionReady
        .then((session) => session.destroy())
        .catch((err: unknown) => {
          log.debug(`Agent ${id.slice(0, 8)} destroy after pending create`, { error: err });
        });
    }

    agentSession.status = "exited";
    agentSession.onExit?.(id, agentSession.hasError ? 1 : 0);

    this.sessions.delete(id);
  }

  /** Destroy all sessions — called on server shutdown. */
  async destroyAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.destroy(id)));
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /** Build a SessionConfig from loxel options, wiring event handlers to the AgentSession bridge. */
  private buildSessionConfig(
    id: string,
    options: { workspaceRoot: string; sessionOptions?: AgentSessionOptions },
  ): SessionConfig {
    const handlers = this.buildHandlers(id);

    return {
      workspaceRoot: options.workspaceRoot,
      models: options.sessionOptions?.models,
      logger: log.with({ sessionId: id.slice(0, 8) }),
      env: buildSpawnEnv(),
      mode: options.sessionOptions?.mode,
      profile: options.sessionOptions?.profile,
      declaredTools: options.sessionOptions?.declaredTools,
      handlers,
    };
  }

  /** Build exhaustive SessionEventHandlers that bridge typed events to AgentEventPayload. */
  private buildHandlers(id: string): SessionEventHandlers {
    /** Resolve session_id from the AgentSession at event time (not creation time). */
    const sid = () => this.sessions.get(id)?.codingAgentSessionId ?? "";

    const bridge = (event: AgentEventPayload) => {
      const agentSession = this.sessions.get(id);
      if (agentSession) this.handleEvent(agentSession, event);
    };

    const now = () => new Date().toISOString();

    return {
      "session.started": (e) =>
        bridge({ type: "session.started", session_id: e.sessionId, timestamp: now(), payload: {} }),

      "session.resumed": (e) =>
        bridge({ type: "session.resumed", session_id: e.sessionId, timestamp: now(), payload: {} }),

      "run.started": (e) =>
        bridge({
          type: "run.started",
          session_id: sid(),
          run_id: e.runId,
          timestamp: now(),
          payload: {},
        }),

      "run.delta": (e) =>
        bridge({
          type: "run.delta",
          session_id: sid(),
          timestamp: now(),
          payload: { text: e.text },
        }),

      "run.reasoning": (e) =>
        bridge({
          type: "run.reasoning",
          session_id: sid(),
          timestamp: now(),
          payload: { text: e.text },
        }),

      "run.completed": (e) =>
        bridge({
          type: "run.completed",
          session_id: sid(),
          run_id: e.runId,
          timestamp: now(),
          payload: { text: e.text, message_id: "" },
        }),

      "run.failed": (e) =>
        bridge({
          type: "run.failed",
          session_id: sid(),
          run_id: e.runId,
          timestamp: now(),
          payload: { message: e.message },
        }),

      "run.cancelled": (e) =>
        bridge({
          type: "run.cancelled",
          session_id: sid(),
          run_id: e.runId,
          timestamp: now(),
          payload: {},
        }),

      "tool.call.requested": (e) =>
        bridge({
          type: "tool.call.requested",
          session_id: sid(),
          timestamp: now(),
          payload: { tool_name: e.toolName, tool_call_id: e.toolCallId, input: e.input },
        }),

      "tool.call.result": (e) =>
        bridge({
          type: "tool.call.result",
          session_id: sid(),
          timestamp: now(),
          payload: {
            tool_name: e.toolName,
            tool_call_id: e.toolCallId,
            output: e.output,
            is_error: e.isError,
          },
        }),

      "approval.requested": (e) => {
        const agentSession = this.sessions.get(id);
        if (agentSession) {
          agentSession.respondCallbacks.set(e.key, e.respond as (...args: unknown[]) => void);
        }
        bridge({
          type: "approval.requested",
          session_id: sid(),
          timestamp: now(),
          payload: {
            key: e.key,
            tool_name: e.toolName,
            input: e.input,
            reason: e.reason,
            options: ["allow", "allow_this_session", "allow_always", "deny"],
          },
        });
      },

      "human.input.requested": (e) => {
        const agentSession = this.sessions.get(id);
        if (agentSession) {
          agentSession.respondCallbacks.set(e.key, e.respond as (...args: unknown[]) => void);
        }
        bridge({
          type: "human.input.requested",
          session_id: sid(),
          timestamp: now(),
          payload: { key: e.key, questions: e.questions },
        });
      },

      "message.received": (e) =>
        bridge({
          type: "message.received",
          session_id: sid(),
          timestamp: now(),
          payload: {
            client_message_id: e.clientMessageId,
            server_message_id: e.serverMessageId,
            role: e.role,
            parent_message_id: e.parentMessageId,
          },
        }),

      "session.rewound": (e) =>
        bridge({
          type: "session.rewound",
          session_id: sid(),
          timestamp: now(),
          payload: { rewind_to_message_id: e.messageId, active_branch_id: e.branchId },
        }),

      "plan.mode.entered": (e) =>
        bridge({
          type: "plan.mode.entered",
          session_id: sid(),
          timestamp: now(),
          payload: { plan_file_path: e.planFilePath },
        }),

      "plan.mode.exited": (e) =>
        bridge({
          type: "plan.mode.exited",
          session_id: sid(),
          timestamp: now(),
          payload: { plan_file_path: e.planFilePath, approved: e.approved },
        }),

      "plan.updated": (e) =>
        bridge({
          type: "plan.updated",
          session_id: sid(),
          timestamp: now(),
          payload: { plan_file_path: e.planFilePath, steps: e.steps },
        }),

      "plan.step.changed": (e) =>
        bridge({
          type: "plan.step.changed",
          session_id: sid(),
          timestamp: now(),
          payload: { step_id: e.stepId, from: e.from, to: e.to },
        }),

      "plan.completed": (e) =>
        bridge({
          type: "plan.completed",
          session_id: sid(),
          timestamp: now(),
          payload: { plan_file_path: e.planFilePath, steps: e.stepCount },
        }),

      "todo.updated": (e) =>
        bridge({
          type: "todo.updated",
          session_id: sid(),
          timestamp: now(),
          payload: { todos: e.todos },
        }),

      "session.got": (e) =>
        bridge({
          type: "session.got",
          session_id: sid(),
          timestamp: now(),
          payload: { session: e.session },
        }),

      error: (e) => {
        const agentSession = this.sessions.get(id);
        if (agentSession) {
          agentSession.hasError = true;
          log.error(`Agent ${id.slice(0, 8)} runtime error`, {
            code: e.diagnostic.code,
            message: e.diagnostic.message,
          });
        }
      },
    };
  }

  /** Register an AgentSession in the maps and scope index. */
  private registerSession(
    id: string,
    options: { workspaceRoot: string; scopeKey: string; codingAgentSessionId?: string },
    sessionReady: Promise<Session>,
    onEvent: EventCallback,
    onExit: ExitCallback,
  ): AgentSession {
    log.info(`Spawning agent session ${id.slice(0, 8)} in ${options.workspaceRoot}`);

    const agentSession: AgentSession = {
      id,
      codingAgentSessionId: options.codingAgentSessionId ?? null,
      scopeKey: options.scopeKey,
      session: null,
      sessionReady,
      abortController: null,
      respondCallbacks: new Map(),
      eventBuffer: [],
      eventSeq: 0,
      status: "starting",
      workspaceRoot: options.workspaceRoot,
      hasError: false,
      onEvent,
      onExit,
    };

    this.sessions.set(id, agentSession);

    let scopeSet = this.scopeIndex.get(options.scopeKey);
    if (!scopeSet) {
      scopeSet = new Set();
      this.scopeIndex.set(options.scopeKey, scopeSet);
    }
    scopeSet.add(id);

    return agentSession;
  }

  private handleEvent(session: AgentSession, event: AgentEventPayload): void {
    // On rewind/resume, clear the event buffer so reconnect replays start fresh
    if (event.type === "session.resumed" || event.type === "session.rewound") {
      session.eventBuffer = [];
      session.eventSeq = 0;
    }

    // Derive status from event type
    const newStatus = deriveAgentStatus(event.type);
    if (newStatus) session.status = newStatus;

    // Buffer event with monotonic seq
    session.eventSeq++;
    session.eventBuffer.push({ event, seq: session.eventSeq });

    // Evict oldest if buffer is full
    while (session.eventBuffer.length > MAX_EVENT_BUFFER) {
      session.eventBuffer.shift();
    }

    // Forward to attached client
    stress.track("agent-event", { sessionId: session.id });
    session.onEvent?.(session.id, event, session.eventSeq);
  }

  private removeFromIndex(session: AgentSession): void {
    const scopeSet = this.scopeIndex.get(session.scopeKey);
    if (scopeSet) {
      scopeSet.delete(session.id);
      if (scopeSet.size === 0) this.scopeIndex.delete(session.scopeKey);
    }
  }
}
