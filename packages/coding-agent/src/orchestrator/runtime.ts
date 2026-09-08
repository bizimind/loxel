import { createNoopLogger, type AppLogger } from "@bizimind/logger";

import type { ProtocolRequest } from "../protocol/schemas.ts";
import type { ProtocolEvent } from "../protocol/schemas.ts";
import type { SessionRecord } from "../session/model.ts";
import { SessionStore } from "../session/store.ts";
import { normalizeToolName } from "../tools/tool-names.ts";
import { createEventId, createRunId } from "../utils/ids.ts";
import { redactSecrets } from "../utils/redaction.ts";
import { Orchestrator, type RunInputMessage } from "./loop.ts";
import { ModelRouter, type ModelRouterOptions } from "./model-router.ts";

interface PendingApproval {
  resolve: (decision: "allow" | "allow_this_session" | "allow_always" | "deny") => void;
  reject: (reason: Error) => void;
}

interface PendingQuestion {
  resolve: (answer: unknown) => void;
  reject: (reason: Error) => void;
}

function nowIso(): string {
  return new Date().toISOString();
}

const PERSISTED_PROTOCOL_EVENT_TYPES = new Set<string>([
  "run.started",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "tool.call.requested",
  "tool.call.result",
  "plan.updated",
  "plan.step.changed",
  "plan.completed",
  "plan.mode.entered",
  "plan.mode.exited",
  "human.input.requested",
  "human.input.response",
  "approval.requested",
  "approval.granted",
  "approval.denied",
  "session.started",
  "session.resumed",
  "session.rewound",
  "session.forked",
  "context.compaction.started",
  "context.compaction.completed",
  "context.compaction.failed",
]);

export interface RuntimeEventSink {
  emit: (event: ProtocolEvent) => Promise<void>;
}

export interface RuntimeDiagnostic {
  level: "warning" | "error";
  code: string;
  message: string;
  sessionId: string;
  runId?: string;
  requestId?: string;
  timestamp: string;
  details?: Record<string, unknown>;
}

export type RuntimeDiagnosticListener = (diagnostic: RuntimeDiagnostic) => void | Promise<void>;

export class CodingAgentRuntime {
  private readonly sessionStore: SessionStore;
  private readonly modelRouter: ModelRouter;
  private readonly logger: AppLogger;

  private readonly activeRunBySession = new Map<string, string>();
  private readonly cancelledRuns = new Set<string>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly pendingApprovalAliases = new Map<string, string>();
  private readonly pendingQuestions = new Map<string, PendingQuestion>();
  private readonly diagnosticListeners = new Set<RuntimeDiagnosticListener>();

  private readonly spawnEnv?: Record<string, string | undefined>;

  constructor(
    private readonly sink: RuntimeEventSink,
    logger: AppLogger = createNoopLogger(),
    modelOptions?: ModelRouterOptions,
    spawnEnv?: Record<string, string | undefined>,
  ) {
    this.logger = logger.with({ component: "runtime" });
    this.sessionStore = new SessionStore();
    this.modelRouter = new ModelRouter(modelOptions ?? {}, this.logger);
    this.spawnEnv = spawnEnv;
  }

  on(event: "error", listener: RuntimeDiagnosticListener): () => void {
    if (event !== "error") {
      return () => {};
    }
    this.diagnosticListeners.add(listener);
    return () => {
      this.diagnosticListeners.delete(listener);
    };
  }

  /** Tear down the runtime: reject pending promises, cancel active runs, clear listeners. */
  destroy(): void {
    const destroyError = new Error("Session destroyed");

    for (const [key, pending] of this.pendingApprovals) {
      pending.reject(destroyError);
      this.pendingApprovals.delete(key);
    }
    this.pendingApprovalAliases.clear();

    for (const [key, pending] of this.pendingQuestions) {
      pending.reject(destroyError);
      this.pendingQuestions.delete(key);
    }

    for (const [, runId] of this.activeRunBySession) {
      this.cancelledRuns.add(runId);
    }
    this.activeRunBySession.clear();

    this.diagnosticListeners.clear();
  }

  private async emitDiagnostic(diagnostic: RuntimeDiagnostic): Promise<void> {
    if (diagnostic.level === "error") {
      this.logger.error("Runtime diagnostic emitted", {
        code: diagnostic.code,
        message: diagnostic.message,
        sessionId: diagnostic.sessionId,
        runId: diagnostic.runId,
        requestId: diagnostic.requestId,
        details: diagnostic.details,
      });
    } else {
      this.logger.warn("Runtime diagnostic emitted", {
        code: diagnostic.code,
        message: diagnostic.message,
        sessionId: diagnostic.sessionId,
        runId: diagnostic.runId,
        requestId: diagnostic.requestId,
        details: diagnostic.details,
      });
    }

    for (const listener of this.diagnosticListeners) {
      try {
        await listener(diagnostic);
      } catch {
        // Listener errors should not affect runtime flow.
      }
    }

    const event: ProtocolEvent = {
      type: diagnostic.level === "error" ? "runtime.error" : "runtime.warning",
      request_id: diagnostic.requestId,
      session_id: diagnostic.sessionId,
      run_id: diagnostic.runId,
      timestamp: diagnostic.timestamp,
      payload: {
        code: diagnostic.code,
        message: diagnostic.message,
        details: diagnostic.details ?? {},
      },
    };

    try {
      await this.sink.emit(redactSecrets(event));
    } catch {
      // Sink delivery failures are terminal to observability, but we avoid recursive failures.
    }
  }

  private async emitFull(event: ProtocolEvent): Promise<void> {
    const redacted = redactSecrets(event);
    await this.sink.emit(redacted);

    if (
      !PERSISTED_PROTOCOL_EVENT_TYPES.has(redacted.type) ||
      redacted.session_id === "system" ||
      redacted.session_id === "unknown"
    ) {
      return;
    }

    const subagentId =
      typeof redacted.payload.subagent_id === "string" ? redacted.payload.subagent_id : null;
    try {
      await this.sessionStore.appendEvent(
        redacted.session_id,
        "protocol.event",
        {
          event_type: redacted.type,
          event_timestamp: redacted.timestamp,
          payload: redacted.payload,
        },
        {
          requestId: redacted.request_id,
          runId: redacted.run_id,
          scope: subagentId
            ? { kind: "subagent", agentId: subagentId, parentAgentId: "main" }
            : undefined,
        },
      );
    } catch (error) {
      this.logger.error("Failed to persist protocol event", {
        eventType: redacted.type,
        sessionId: redacted.session_id,
        runId: redacted.run_id,
        requestId: redacted.request_id,
        error,
      });
      await this.emitDiagnostic({
        level: "error",
        code: "PROTOCOL_EVENT_PERSIST_FAILED",
        message: "Failed to append protocol event into session events.jsonl",
        sessionId: redacted.session_id,
        runId: redacted.run_id,
        requestId: redacted.request_id,
        timestamp: nowIso(),
        details: {
          persisted_event_type: redacted.type,
          cause: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private async emit(event: Omit<ProtocolEvent, "timestamp">): Promise<void> {
    await this.emitFull({ ...event, timestamp: nowIso() });
  }

  private createOrchestrator() {
    return new Orchestrator(
      this.sessionStore,
      this.modelRouter,
      {
        emitEvent: async (event) => {
          await this.emitFull(event);
        },
        onHumanQuestion: async (req) => {
          const pendingKey = `${req.runId}:question:${createEventId()}`;
          await this.emit({
            type: "human.input.requested",
            request_id: undefined,
            session_id: req.sessionId,
            run_id: req.runId,
            payload: { key: pendingKey, tool_name: req.toolName, input: req.input },
          });

          return new Promise<unknown>((resolve, reject) => {
            this.pendingQuestions.set(pendingKey, { resolve, reject });
          });
        },
        onApproval: async (req) => {
          const pendingKey = `${req.runId}:approval:${createEventId()}`;
          const aliasKey = `${req.runId}:approval:${req.toolName}`;
          this.pendingApprovalAliases.set(aliasKey, pendingKey);
          await this.emit({
            type: "approval.requested",
            request_id: undefined,
            session_id: req.sessionId,
            run_id: req.runId,
            payload: {
              key: pendingKey,
              tool_name: req.toolName,
              input: req.input,
              reason: req.reason,
              options: ["allow", "allow_this_session", "allow_always", "deny"],
            },
          });

          return new Promise<"allow" | "allow_this_session" | "allow_always" | "deny">(
            (resolve, reject) => {
              this.pendingApprovals.set(pendingKey, { resolve, reject });
            },
          );
        },
        isCancelled: (runId: string) => this.cancelledRuns.has(runId),
      },
      this.logger,
      this.spawnEnv,
    );
  }

  private async loadSessionOrThrow(sessionId: string): Promise<SessionRecord> {
    return this.sessionStore.loadSession(sessionId);
  }

  async handleRequest(request: ProtocolRequest): Promise<void> {
    const requestLog = this.logger.with({
      requestType: request.type,
      requestId: request.request_id,
      sessionId: "session_id" in request ? request.session_id : undefined,
      runId: "run_id" in request ? request.run_id : undefined,
    });
    requestLog.debug("Handling protocol request");

    try {
      switch (request.type) {
        case "session.start": {
          const session = await this.sessionStore.createSession({
            workspaceRoot: request.workspace_root,
            sessionId: request.session_id,
            mode: request.mode,
            profile: request.profile,
            promptProfile: request.prompt_profile,
            declaredTools: request.declared_tools ?? null,
          });

          if (request.messages?.length) {
            const runId = createEventId();
            for (const message of request.messages) {
              await this.sessionStore.appendMessage(session, message.role, message.content, runId);
            }
          }

          requestLog.info("Session started", {
            sessionId: session.id,
            mode: session.state.mode,
            profile: session.state.profile,
            hasInitialMessages: Boolean(request.messages?.length),
          });

          await this.emit({
            type: "session.started",
            request_id: request.request_id,
            session_id: session.id,
            payload: {
              session_id: session.id,
              mode: session.state.mode,
              profile: session.state.profile,
              plan_file_path: session.state.plan.planFilePath,
              declared_tools: session.declaredTools,
            },
          });

          if (session.state.mode === "plan" && session.state.plan.planFilePath) {
            await this.emit({
              type: "plan.mode.entered",
              request_id: request.request_id,
              session_id: session.id,
              payload: { plan_file_path: session.state.plan.planFilePath },
            });
          }

          return;
        }

        case "session.input": {
          const session = await this.loadSessionOrThrow(request.session_id);
          const orchestrator = this.createOrchestrator();
          const messages: RunInputMessage[] = request.messages;
          const runId = createRunId();
          this.activeRunBySession.set(session.id, runId);
          requestLog.info("Dispatching session input run", {
            runId,
            messageCount: messages.length,
            modelProfile: request.model_profile,
            rewindToMessageId: request.rewind_to_message_id,
          });

          const runPromise = orchestrator.runTurn({
            sessionId: session.id,
            modelProfile: request.model_profile,
            rewindToMessageId: request.rewind_to_message_id,
            messages,
            runId,
            approvalOverrides: Object.fromEntries(
              Object.entries(request.approval_overrides ?? {})
                .map(([name, decision]) => [normalizeToolName(name), decision] as const)
                .filter(
                  (
                    entry,
                  ): entry is [
                    Exclude<ReturnType<typeof normalizeToolName>, undefined>,
                    "allow" | "deny",
                  ] => Boolean(entry[0]),
                ),
            ),
          });

          void runPromise
            .then((result) => {
              this.activeRunBySession.delete(session.id);
              this.cancelledRuns.delete(result.runId);
              requestLog.info("Session input run completed", {
                runId: result.runId,
                responseTextLength: result.text.length,
              });
            })
            .catch(async (error) => {
              this.activeRunBySession.delete(session.id);
              requestLog.error("Session input run failed", { runId, error });
              await this.emit({
                type: "run.failed",
                request_id: request.request_id,
                session_id: session.id,
                run_id: runId,
                payload: { message: error instanceof Error ? error.message : String(error) },
              });
            });

          return;
        }

        case "session.cancel": {
          const runId = request.run_id ?? this.activeRunBySession.get(request.session_id);
          if (runId) {
            this.cancelledRuns.add(runId);
          }
          requestLog.info("Cancelled run", { runId });

          await this.emit({
            type: "run.cancelled",
            request_id: request.request_id,
            session_id: request.session_id,
            run_id: runId,
            payload: { run_id: runId },
          });
          return;
        }

        case "session.close": {
          requestLog.info("Session close requested");
          await this.emit({
            type: "session.closed",
            request_id: request.request_id,
            session_id: request.session_id,
            payload: {},
          });
          return;
        }

        case "session.resume": {
          const session = request.rewind_to_message_id
            ? await this.sessionStore.rewind(request.session_id, request.rewind_to_message_id)
            : await this.sessionStore.loadSession(request.session_id);

          requestLog.info("Session resumed", {
            sessionId: session.id,
            rewindToMessageId: request.rewind_to_message_id,
            activeBranchId: session.activeBranchId,
            activeMessageId: session.activeMessageId,
          });
          await this.emit({
            type: "session.resumed",
            request_id: request.request_id,
            session_id: session.id,
            payload: {
              session_id: session.id,
              active_branch_id: session.activeBranchId,
              active_message_id: session.activeMessageId,
              replayed_from_events: true,
            },
          });
          return;
        }

        case "session.fork": {
          const forked = await this.sessionStore.fork(request.session_id, request.message_id);
          requestLog.info("Session forked", {
            newSessionId: forked.id,
            parentSessionId: request.session_id,
            forkPointMessageId: request.message_id ?? null,
          });
          await this.emit({
            type: "session.forked",
            request_id: request.request_id,
            session_id: forked.id,
            payload: {
              session_id: forked.id,
              parent_session_id: request.session_id,
              fork_point_message_id: request.message_id ?? null,
            },
          });
          return;
        }

        case "session.compact": {
          requestLog.info("Session compaction started");
          await this.emit({
            type: "context.compaction.started",
            request_id: request.request_id,
            session_id: request.session_id,
            payload: {},
          });

          try {
            const compacted = await this.sessionStore.compact(request.session_id);
            const latest = compacted.compactions.at(-1);

            requestLog.info("Session compaction completed", {
              compactionId: latest?.id,
              replacementMessageId: latest?.replacementMessageId,
            });

            await this.emit({
              type: "context.compaction.completed",
              request_id: request.request_id,
              session_id: request.session_id,
              payload: {
                compaction_id: latest?.id,
                active_replacement_pointer: latest?.replacementMessageId,
              },
            });
          } catch (error) {
            requestLog.error("Session compaction failed", { error });
            await this.emit({
              type: "context.compaction.failed",
              request_id: request.request_id,
              session_id: request.session_id,
              payload: { message: error instanceof Error ? error.message : String(error) },
            });
          }

          return;
        }

        case "session.list": {
          const sessions = await this.sessionStore.listSessions();
          requestLog.debug("Listed sessions", { count: sessions.length });
          await this.emit({
            type: "session.listed",
            request_id: request.request_id,
            session_id: "system",
            payload: { sessions },
          });
          return;
        }

        case "session.get": {
          const session = await this.sessionStore.loadSession(request.session_id);
          requestLog.debug("Loaded session", {
            activeBranchId: session.activeBranchId,
            activeMessageId: session.activeMessageId,
          });
          await this.emit({
            type: "session.got",
            request_id: request.request_id,
            session_id: session.id,
            payload: { session },
          });
          return;
        }

        case "human.input.response": {
          if (request.pending_key) {
            const pending = this.pendingQuestions.get(request.pending_key);
            if (!pending) {
              requestLog.warn("No pending question for pending_key", {
                pendingKey: request.pending_key,
              });
              throw new Error(`No pending question found for key ${request.pending_key}`);
            }

            pending.resolve({
              answers:
                request.answers ??
                (request.question_id
                  ? { [request.question_id]: request.selected_options ?? [] }
                  : {}),
              freeform:
                request.freeform ??
                (request.question_id && request.freeform_text
                  ? { [request.question_id]: request.freeform_text }
                  : {}),
            });
            this.pendingQuestions.delete(request.pending_key);
            await this.emit({
              type: "human.input.response",
              request_id: request.request_id,
              session_id: request.session_id,
              run_id: request.run_id,
              payload: {
                pending_key: request.pending_key,
                answers: request.answers,
                freeform: request.freeform,
              },
            });
            return;
          }

          if (request.answers) {
            const [firstEntry] = Object.entries(request.answers);
            if (!firstEntry) {
              requestLog.warn("Received empty human.input.response.answers");
              throw new Error("human.input.response.answers is empty");
            }
            const [key] = firstEntry;
            const pending = this.pendingQuestions.get(key);
            if (!pending) {
              requestLog.warn("No pending question for answers key", { pendingKey: key });
              throw new Error(`No pending question found for key ${key}`);
            }

            pending.resolve({ answers: request.answers, freeform: request.freeform });
            this.pendingQuestions.delete(key);
            await this.emit({
              type: "human.input.response",
              request_id: request.request_id,
              session_id: request.session_id,
              run_id: request.run_id,
              payload: { pending_key: key, answers: request.answers, freeform: request.freeform },
            });
            return;
          }

          const candidateKey = `${request.run_id}:question:${request.question_id}`;
          const pending = this.pendingQuestions.get(candidateKey);
          if (!pending) {
            requestLog.warn("No pending question for derived key", { pendingKey: candidateKey });
            throw new Error(`No pending question found for key ${candidateKey}`);
          }

          pending.resolve({
            answers: { [request.question_id ?? "question"]: request.selected_options ?? [] },
            freeform: request.freeform_text
              ? { [request.question_id ?? "question"]: request.freeform_text }
              : {},
          });
          this.pendingQuestions.delete(candidateKey);
          await this.emit({
            type: "human.input.response",
            request_id: request.request_id,
            session_id: request.session_id,
            run_id: request.run_id,
            payload: {
              pending_key: candidateKey,
              question_id: request.question_id,
              selected_options: request.selected_options,
              freeform_text: request.freeform_text,
            },
          });
          return;
        }

        case "approval.response": {
          const fallbackAliasKey = `${request.run_id}:approval:${request.tool_name}`;
          const key =
            request.pending_key ??
            this.pendingApprovalAliases.get(fallbackAliasKey) ??
            fallbackAliasKey;
          const pending = this.pendingApprovals.get(key);
          if (!pending) {
            requestLog.warn("No pending approval for key", { pendingKey: key });
            throw new Error(`No pending approval found for key ${key}`);
          }

          pending.resolve(request.decision);
          this.pendingApprovals.delete(key);
          for (const [alias, target] of this.pendingApprovalAliases.entries()) {
            if (target === key) {
              this.pendingApprovalAliases.delete(alias);
            }
          }

          await this.emit({
            type: request.decision === "deny" ? "approval.denied" : "approval.granted",
            request_id: request.request_id,
            session_id: request.session_id,
            run_id: request.run_id,
            payload: { tool_name: request.tool_name, decision: request.decision },
          });
          return;
        }

        default: {
          const _exhaustive: never = request;
          throw new Error(
            `Unknown protocol request type: ${String((_exhaustive as { type?: string }).type)}`,
          );
        }
      }
    } catch (error) {
      requestLog.error("Protocol request failed", { error });
      throw error;
    }
  }
}
