/**
 * High-level Session API for the coding-agent SDK.
 *
 * Wraps CodingAgentRuntime with an object-oriented interface:
 * - send() returns a result instead of fire-and-forget
 * - AbortSignal for cancellation/steering
 * - rewind() and fork() as direct methods
 * - Typed event handlers via exhaustive Record (no silent hangs)
 */
import { z } from "zod";

import type { RuntimeEventSink } from "../orchestrator/runtime.ts";
import { CodingAgentRuntime } from "../orchestrator/runtime.ts";
import type { ProtocolEvent } from "../protocol/schemas.ts";
import { planStepSchema, todoItemSchema } from "../session/model.ts";
import type {
  MessageContent,
  SendOptions,
  SendResult,
  SessionConfig,
  SessionEvent,
} from "./session-types.ts";

interface PendingRun {
  resolve: (result: SendResult) => void;
  reject: (error: Error) => void;
}

export class Session {
  private sessionId: string;
  private readonly config: SessionConfig;
  private runtime!: CodingAgentRuntime;
  private pendingRun: PendingRun | null = null;
  private pendingRunId: string | null = null;
  private abortCleanup: (() => void) | null = null;
  private destroyed = false;

  private constructor(config: SessionConfig, sessionId: string) {
    this.sessionId = sessionId;
    this.config = config;
  }

  get id(): string {
    return this.sessionId;
  }

  /** Create a new coding-agent session. */
  static async create(config: SessionConfig): Promise<Session> {
    const session = Session.buildWithRuntime(config);

    await session.runtime.handleRequest({
      type: "session.start",
      request_id: crypto.randomUUID(),
      workspace_root: config.workspaceRoot,
      mode: config.mode,
      profile: config.profile,
      prompt_profile: config.promptProfile,
      declared_tools: config.declaredTools,
    });

    await session.waitForSessionId();
    return session;
  }

  /** Resume an existing session by ID. */
  static async resume(sessionId: string, config: SessionConfig): Promise<Session> {
    const session = Session.buildWithRuntime(config);
    session.sessionId = sessionId;

    await session.runtime.handleRequest({
      type: "session.resume",
      request_id: crypto.randomUUID(),
      session_id: sessionId,
    });

    return session;
  }

  /** Send a user message. Resolves when the run completes. */
  send(message?: MessageContent, options?: SendOptions): Promise<SendResult> {
    if (this.destroyed) return Promise.reject(new Error("Session is destroyed"));
    if (this.pendingRun) return Promise.reject(new Error("A run is already in progress"));
    if (options?.signal?.aborted) return Promise.reject(new Error("Signal already aborted"));

    const { promise, resolve, reject } = Promise.withResolvers<SendResult>();
    this.pendingRun = { resolve, reject };

    // Hook abort signal to session.cancel
    if (options?.signal) {
      const onAbort = () => {
        // Reject pending run synchronously so the caller's rejection handler fires immediately
        if (this.pendingRun) {
          const { reject } = this.pendingRun;
          this.pendingRun = null;
          this.abortCleanup = null;
          reject(new Error("Run cancelled"));
        }
        // Still tell the runtime to cancel for cleanup
        void this.runtime.handleRequest({
          type: "session.cancel",
          request_id: crypto.randomUUID(),
          session_id: this.id,
        });
      };
      options.signal.addEventListener("abort", onAbort, { once: true });
      // Store cleanup so handleProtocolEvent can remove the listener when the run settles.
      // NOTE: Do NOT use promise.finally() or promise.then() for cleanup —
      // attaching derived chains to the withResolvers promise breaks Bun's expect().rejects.
      this.abortCleanup = () => {
        options.signal!.removeEventListener("abort", onAbort);
        this.abortCleanup = null;
      };
    }

    const content = typeof message === "string" ? message : message ? JSON.stringify(message) : "";
    const hasContent = content.trim().length > 0;

    // Start the request without awaiting — the promise settles via handleProtocolEvent
    this.runtime
      .handleRequest({
        type: "session.input",
        request_id: crypto.randomUUID(),
        session_id: this.id,
        messages: hasContent ? [{ role: "user", content }] : [],
        model_profile: options?.modelProfile,
        approval_overrides: options?.approvalOverrides,
      })
      .catch((err) => {
        // If handleRequest itself fails (not the model run), reject the promise
        if (this.pendingRun) {
          this.pendingRun.reject(err instanceof Error ? err : new Error(String(err)));
          this.pendingRun = null;
          this.abortCleanup?.();
        }
      });

    return promise;
  }

  /** Rewind conversation to before the given message. Creates a branch internally. */
  async rewind(messageId: string): Promise<void> {
    this.assertAlive();

    // Cancel current run if one is pending
    if (this.pendingRun) {
      const { reject } = this.pendingRun;
      this.pendingRun = null;
      this.pendingRunId = null;
      this.abortCleanup?.();

      void this.runtime.handleRequest({
        type: "session.cancel",
        request_id: crypto.randomUUID(),
        session_id: this.id,
      });

      reject(new Error("Run cancelled by rewind"));
    }

    await this.runtime.handleRequest({
      type: "session.resume",
      request_id: crypto.randomUUID(),
      session_id: this.id,
      rewind_to_message_id: messageId,
    });
  }

  /** Fork from a message point, returning a new independent Session. */
  async fork(messageId?: string): Promise<Session> {
    this.assertAlive();

    // Fork the session in the store via protocol
    const forkedSessionId = await new Promise<string>((resolve, reject) => {
      const unsub = this.runtime.on("error", (diag) => {
        this.dispatchEvent = originalDispatch;
        unsub();
        reject(new Error(diag.message));
      });

      // Listen for the session.forked event to get the new session ID
      const originalDispatch = this.dispatchEvent.bind(this);
      this.dispatchEvent = (event: ProtocolEvent) => {
        if (event.type === "session.forked") {
          this.dispatchEvent = originalDispatch;
          unsub();
          resolve(String((event.payload as Record<string, unknown>).session_id));
          return;
        }
        originalDispatch(event);
      };

      this.runtime
        .handleRequest({
          type: "session.fork",
          request_id: crypto.randomUUID(),
          session_id: this.id,
          message_id: messageId,
        })
        .catch((err) => {
          this.dispatchEvent = originalDispatch;
          unsub();
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    });

    // Create a new Session that resumes the forked session
    return Session.resume(forkedSessionId, this.config);
  }

  /** Compact the conversation context. */
  async compact(): Promise<void> {
    this.assertAlive();
    await this.runtime.handleRequest({
      type: "session.compact",
      request_id: crypto.randomUUID(),
      session_id: this.id,
    });
  }

  /** Fetch the current session record. Emits a session.got event with the data. */
  async getRecord(): Promise<void> {
    this.assertAlive();
    await this.runtime.handleRequest({
      type: "session.get",
      request_id: crypto.randomUUID(),
      session_id: this.id,
    });
  }

  /** Tear down the session. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.abortCleanup?.();
    if (this.pendingRun) {
      this.pendingRun.reject(new Error("Session destroyed"));
      this.pendingRun = null;
    }
    this.runtime.destroy();
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private assertAlive(): void {
    if (this.destroyed) throw new Error("Session is destroyed");
  }

  private sessionIdResolve: (() => void) | null = null;

  /** Build a Session with a wired runtime. Session ID is set later from events. */
  private static buildWithRuntime(config: SessionConfig): Session {
    // Create session first so the sink can reference it
    const session = new Session(config, "");

    const sink: RuntimeEventSink = {
      emit: async (event) => {
        session.handleProtocolEvent(event);
      },
    };

    const runtime = new CodingAgentRuntime(sink, config.logger, config.models, config.env);
    session.runtime = runtime;

    runtime.on("error", (diagnostic) => {
      session.dispatchTypedEvent({ type: "error", diagnostic });
    });

    return session;
  }

  /** Wait for session.started/session.resumed to capture the session ID. */
  private waitForSessionId(): Promise<void> {
    if (this.sessionId) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.sessionIdResolve = resolve;
    });
  }

  /** Handle a raw ProtocolEvent from the runtime sink. */
  private handleProtocolEvent(event: ProtocolEvent): void {
    // Capture session ID from startup events
    if ((event.type === "session.started" || event.type === "session.resumed") && !this.sessionId) {
      this.sessionId = event.session_id;
      this.sessionIdResolve?.();
      this.sessionIdResolve = null;
    }

    this.dispatchEvent(event);

    // Capture the active run ID so we only settle the promise for the current run
    if (event.type === "run.started" && this.pendingRun) {
      this.pendingRunId = event.run_id ?? null;
    }

    // Resolve/reject pending send() promise — only for the active run
    const isActiveRun = !event.run_id || event.run_id === this.pendingRunId;
    if (event.type === "run.completed" && this.pendingRun && isActiveRun) {
      const p = event.payload as Record<string, unknown>;
      this.pendingRun.resolve({
        messageId: String(p.message_id ?? ""),
        runId: event.run_id ?? "",
        text: String(p.text ?? ""),
      });
      this.pendingRun = null;
      this.pendingRunId = null;
      this.abortCleanup?.();
    }
    if (event.type === "run.failed" && this.pendingRun && isActiveRun) {
      const p = event.payload as Record<string, unknown>;
      this.pendingRun.reject(new Error(String(p.message ?? "Run failed")));
      this.pendingRun = null;
      this.pendingRunId = null;
      this.abortCleanup?.();
    }
    if (event.type === "run.cancelled" && this.pendingRun && isActiveRun) {
      this.pendingRun.reject(new Error("Run cancelled"));
      this.pendingRun = null;
      this.pendingRunId = null;
      this.abortCleanup?.();
    }
  }

  /** Convert a ProtocolEvent to a typed SessionEvent and dispatch to the appropriate handler. */
  private dispatchEvent(event: ProtocolEvent): void {
    const p = event.payload as Record<string, unknown>;

    switch (event.type) {
      case "session.started":
        this.dispatchTypedEvent({ type: "session.started", sessionId: event.session_id });
        break;

      case "session.resumed":
        this.dispatchTypedEvent({ type: "session.resumed", sessionId: event.session_id });
        break;

      case "run.started":
        this.dispatchTypedEvent({ type: "run.started", runId: event.run_id ?? "" });
        break;

      case "run.delta":
        this.dispatchTypedEvent({ type: "run.delta", text: String(p.text ?? p.delta ?? "") });
        break;

      case "run.reasoning":
        this.dispatchTypedEvent({ type: "run.reasoning", text: String(p.text ?? "") });
        break;

      case "run.completed":
        this.dispatchTypedEvent({
          type: "run.completed",
          runId: event.run_id ?? "",
          text: String(p.text ?? ""),
        });
        break;

      case "run.failed":
        this.dispatchTypedEvent({
          type: "run.failed",
          runId: event.run_id ?? "",
          message: String(p.message ?? "Run failed"),
        });
        break;

      case "run.cancelled":
        this.dispatchTypedEvent({ type: "run.cancelled", runId: event.run_id ?? "" });
        break;

      case "tool.call.requested":
        this.dispatchTypedEvent({
          type: "tool.call.requested",
          toolName: String(p.tool_name ?? ""),
          toolCallId: String(p.tool_call_id ?? ""),
          input: p.input,
        });
        break;

      case "tool.call.result": {
        const toolName = String(p.tool_name ?? "");
        this.dispatchTypedEvent({
          type: "tool.call.result",
          toolName,
          toolCallId: String(p.tool_call_id ?? ""),
          output: p.output,
          isError: Boolean(p.is_error),
        });

        // Synthesise todo.updated when TodoWrite succeeds
        if (toolName === "TodoWrite" && !p.is_error) {
          const output = p.output as Record<string, unknown> | undefined;
          const parsed = z.array(todoItemSchema).safeParse(output?.todos);
          if (parsed.success) {
            this.dispatchTypedEvent({ type: "todo.updated", todos: parsed.data });
          }
        }
        break;
      }

      case "approval.requested":
        this.dispatchTypedEvent({
          type: "approval.requested",
          key: String(p.key ?? ""),
          toolName: String(p.tool_name ?? ""),
          input: p.input,
          reason: String(p.reason ?? ""),
          respond: (decision) => {
            void this.runtime.handleRequest({
              type: "approval.response",
              request_id: crypto.randomUUID(),
              session_id: this.id,
              run_id: event.run_id ?? "",
              pending_key: String(p.key ?? ""),
              tool_name: String(p.tool_name ?? ""),
              decision,
            });
          },
        });
        break;

      case "human.input.requested": {
        const questions = Array.isArray(p.questions)
          ? (p.questions as Array<Record<string, unknown>>).map((q) => ({
              id: String(q.id ?? "q"),
              question: String(q.question ?? ""),
              options: Array.isArray(q.options)
                ? (q.options as Array<Record<string, unknown>>).map((o) => ({
                    label: String(o.label ?? ""),
                    description: String(o.description ?? ""),
                  }))
                : [],
              multiSelect: typeof q.multiSelect === "boolean" ? q.multiSelect : undefined,
            }))
          : [];

        this.dispatchTypedEvent({
          type: "human.input.requested",
          key: String(p.key ?? ""),
          questions,
          respond: (answers, freeform) => {
            void this.runtime.handleRequest({
              type: "human.input.response",
              request_id: crypto.randomUUID(),
              session_id: this.id,
              run_id: event.run_id ?? "",
              pending_key: String(p.key ?? ""),
              answers,
              freeform,
            });
          },
        });
        break;
      }

      case "message.received":
        this.dispatchTypedEvent({
          type: "message.received",
          clientMessageId: typeof p.client_message_id === "string" ? p.client_message_id : null,
          serverMessageId: String(p.server_message_id ?? ""),
          role: String(p.role ?? ""),
          parentMessageId: typeof p.parent_message_id === "string" ? p.parent_message_id : null,
        });
        break;

      case "session.rewound":
        this.dispatchTypedEvent({
          type: "session.rewound",
          messageId: String(p.rewind_to_message_id ?? p.rewindTo ?? ""),
          branchId: String(p.active_branch_id ?? p.activeBranchId ?? ""),
        });
        break;

      case "plan.mode.entered":
        this.dispatchTypedEvent({
          type: "plan.mode.entered",
          planFilePath: typeof p.plan_file_path === "string" ? p.plan_file_path : null,
        });
        break;

      case "plan.mode.exited":
        this.dispatchTypedEvent({
          type: "plan.mode.exited",
          planFilePath: typeof p.plan_file_path === "string" ? p.plan_file_path : null,
          approved: Boolean(p.approved),
        });
        break;

      case "plan.updated": {
        const parsedSteps = z.array(planStepSchema).safeParse(p.steps);
        this.dispatchTypedEvent({
          type: "plan.updated",
          planFilePath: typeof p.plan_file_path === "string" ? p.plan_file_path : null,
          steps: parsedSteps.success ? parsedSteps.data : [],
        });
        break;
      }

      case "plan.step.changed":
        this.dispatchTypedEvent({
          type: "plan.step.changed",
          stepId: String(p.step_id ?? ""),
          from: String(p.from ?? ""),
          to: String(p.to ?? ""),
        });
        break;

      case "plan.completed":
        this.dispatchTypedEvent({
          type: "plan.completed",
          planFilePath: typeof p.plan_file_path === "string" ? p.plan_file_path : null,
          stepCount: typeof p.steps === "number" ? p.steps : 0,
        });
        break;

      case "session.got": {
        const sessionData =
          typeof p.session === "object" && p.session !== null
            ? (p.session as Record<string, unknown>)
            : {};
        this.dispatchTypedEvent({ type: "session.got", session: sessionData });
        break;
      }

      // Internal events not exposed to the public API
      default:
        break;
    }
  }

  /** Dispatch a typed SessionEvent to the appropriate handler. */
  private dispatchTypedEvent(event: SessionEvent): void {
    const handler = this.config.handlers[event.type];
    if (handler) {
      (handler as (e: SessionEvent) => void)(event);
    }
  }
}
