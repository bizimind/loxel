import { createNoopLogger, type AppLogger } from "@bizimind/logger";
import { streamText, stepCountIs, type ModelMessage } from "ai";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { ProtocolEvent } from "../protocol/schemas.ts";
import type { SessionRecord } from "../session/model.ts";
import type { SessionStore } from "../session/store.ts";
import type { ToolRuntimeContext } from "../tools/context.ts";
import type { CanonicalToolName } from "../tools/tool-names.ts";
import type { ModelProfile, ModelRouter } from "./model-router.ts";

import { LoopControlBreakError, isToolPolicyViolation } from "../core/errors.ts";
import { PermissionStore } from "../permissions/store.ts";
import { buildPromptAssembly } from "../prompts/assembler.ts";
import { markReminderInjected } from "../prompts/reminders.ts";
import { ensureStateLayout, getSessionPaths, getStateLayout } from "../state/layout.ts";
import { normalizeDeclaredTools } from "../tools/capabilities.ts";
import { createAiToolSet } from "../tools/registry.ts";
import { TaskManager } from "../tools/task-manager.ts";
import { createPlanFileName, createRunId } from "../utils/ids.ts";
import { asRecord } from "../utils/record.ts";
import {
  verifyConditions,
  formatUnmetConditions,
  type CompletionCondition,
  type TaskStatus,
} from "./completion-conditions.ts";
import { LoopController, DEFAULT_LOOP_CONTROL_CONFIG } from "./loop-control.ts";

// Maximum steps as a safety limit. The loop terminates naturally when the model
// returns a finish_reason other than "tool-calls". This limit prevents runaway
// execution in edge cases.
const MAX_AGENT_STEPS = 100;

export interface OrchestratorCallbacks {
  emitEvent: (event: ProtocolEvent) => Promise<void>;
  onHumanQuestion: ToolRuntimeContext["onHumanQuestion"];
  onApproval: ToolRuntimeContext["onApproval"];
  isCancelled: (runId: string) => boolean;
}

export interface RunInputMessage {
  id?: string;
  role: "system" | "user" | "assistant" | "tool";
  content: unknown;
}

export interface LoopControlOptions {
  /** Completion conditions to verify before allowing task completion. */
  completionConditions?: CompletionCondition[];
  /** Enable loop detection and LLM judgment. */
  enableLoopDetection?: boolean;
  /** Check progress every N tool calls (default: 50). */
  periodicCheckInterval?: number;
  /** Maximum tool calls before forcing stop (default: 500). */
  maxSafetySteps?: number;
}

export interface RunTurnInput {
  sessionId: string;
  modelProfile?: ModelProfile;
  rewindToMessageId?: string;
  messages: RunInputMessage[];
  runId?: string;
  approvalOverrides?: Partial<Record<CanonicalToolName, "allow" | "deny">>;
  loopControl?: LoopControlOptions;
}

export interface RunTurnResult {
  runId: string;
  session: SessionRecord;
  text: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function toModelMessages(
  messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: unknown }>,
): ModelMessage[] {
  const out: ModelMessage[] = [];

  for (const msg of messages) {
    switch (msg.role) {
      case "system":
        out.push({ role: "system", content: String(msg.content ?? "") });
        break;
      case "user":
        out.push({ role: "user", content: String(msg.content ?? "") });
        break;
      case "assistant":
        out.push({ role: "assistant", content: String(msg.content ?? "") });
        break;
      case "tool":
        // Tool messages require structured content in AI SDK. Persisted sessions can contain
        // arbitrary tool payloads, so we normalize to a descriptive assistant-safe message.
        out.push({ role: "assistant", content: `Tool result: ${JSON.stringify(msg.content)}` });
        break;
      default: {
        const _exhaustive: never = msg.role;
        throw new Error(`Unknown message role: ${String(_exhaustive)}`);
      }
    }
  }

  return out;
}

async function ensurePlanFileForPlanMode(
  sessionStore: SessionStore,
  session: SessionRecord,
): Promise<void> {
  if (session.state.mode !== "plan") {
    return;
  }

  if (session.state.plan.planFilePath) {
    const exists = await Bun.file(session.state.plan.planFilePath).exists();
    if (exists) {
      return;
    }
  }

  await ensureStateLayout();
  const layout = getStateLayout();
  await mkdir(layout.plansDir, { recursive: true });
  const planPath = path.join(layout.plansDir, createPlanFileName());
  await Bun.write(planPath, "# Plan\n\n");

  session.state.plan.planFilePath = planPath;
  await sessionStore.setState(session, session.state);
}

function composeSystemPrompt(segments: ReturnType<typeof buildPromptAssembly>): string {
  return [
    ...segments.systemSegments.map((segment) => segment.content),
    ...segments.developerSegments.map((segment) => segment.content),
    ...segments.ephemeralReminderSegments.map((segment) => segment.content),
  ].join("\n\n");
}

export function collectWebSourcesFromToolOutput(toolName: string, output: unknown): string[] {
  const outputRecord = asRecord(output);
  if (!outputRecord) {
    return [];
  }

  if (toolName === "WebFetch") {
    const url = outputRecord.url;
    return typeof url === "string" ? [url] : [];
  }

  if (toolName === "WebSearch") {
    const results = outputRecord.results;
    if (!Array.isArray(results)) {
      return [];
    }
    const urls: string[] = [];
    for (const item of results) {
      const itemRecord = asRecord(item);
      if (!itemRecord) {
        continue;
      }
      const url = itemRecord.url;
      if (typeof url === "string") {
        urls.push(url);
      }
    }
    return urls;
  }

  return [];
}

export function ensureSourcesSection(text: string, sources: string[]): string {
  if (sources.length === 0) {
    return text;
  }
  if (/^\s*Sources\s*:/im.test(text)) {
    return text;
  }

  const unique = Array.from(new Set(sources));
  const lines = unique.slice(0, 8).map((url) => `- [${url}](${url})`);
  return `${text.trimEnd()}\n\nSources:\n${lines.join("\n")}`;
}

function estimateCostUsd(inputTokens: number, outputTokens: number): number | null {
  const inPerM = Number.parseFloat(process.env.CODING_AGENT_COST_INPUT_USD_PER_M ?? "");
  const outPerM = Number.parseFloat(process.env.CODING_AGENT_COST_OUTPUT_USD_PER_M ?? "");
  if (!Number.isFinite(inPerM) || !Number.isFinite(outPerM)) {
    return null;
  }

  const inputCost = (inputTokens / 1_000_000) * inPerM;
  const outputCost = (outputTokens / 1_000_000) * outPerM;
  return Number((inputCost + outputCost).toFixed(8));
}

export class Orchestrator {
  private readonly logger: AppLogger;

  constructor(
    private readonly sessionStore: SessionStore,
    private readonly modelRouter: ModelRouter,
    private readonly callbacks: OrchestratorCallbacks,
    logger: AppLogger = createNoopLogger(),
    private readonly spawnEnv?: Record<string, string | undefined>,
  ) {
    this.logger = logger.with({ component: "orchestrator" });
  }

  async runTurn(input: RunTurnInput): Promise<RunTurnResult> {
    let session = await this.sessionStore.loadSession(input.sessionId);

    if (input.rewindToMessageId) {
      session = await this.sessionStore.rewind(session.id, input.rewindToMessageId);
      await this.callbacks.emitEvent({
        type: "session.rewound",
        request_id: undefined,
        session_id: session.id,
        timestamp: nowIso(),
        payload: {
          rewind_to_message_id: input.rewindToMessageId,
          active_branch_id: session.activeBranchId,
        },
      });
    }

    await ensurePlanFileForPlanMode(this.sessionStore, session);

    const runId = input.runId ?? createRunId();
    const log = this.logger.with({ sessionId: session.id, runId });
    log.info("Starting run turn", {
      messageCount: input.messages.length,
      modelProfile: input.modelProfile,
      rewindToMessageId: input.rewindToMessageId,
    });

    for (const message of input.messages) {
      const appended = await this.sessionStore.appendMessage(
        session,
        message.role,
        message.content,
        runId,
      );
      session = await this.sessionStore.loadSession(session.id);

      // Echo the server-assigned message ID back to the client
      await this.callbacks.emitEvent({
        type: "message.received",
        request_id: undefined,
        session_id: session.id,
        run_id: runId,
        timestamp: nowIso(),
        payload: {
          client_message_id: message.id ?? null,
          server_message_id: appended.id,
          role: appended.role,
          parent_message_id: appended.parentMessageId,
        },
      });
    }

    await this.callbacks.emitEvent({
      type: "run.started",
      request_id: undefined,
      session_id: session.id,
      run_id: runId,
      timestamp: nowIso(),
      payload: {
        model_profile:
          input.modelProfile ?? (session.state.mode === "plan" ? "planner" : "executor"),
      },
    });

    const promptAssembly = buildPromptAssembly({
      session,
      dateIso: new Date().toISOString().slice(0, 10),
      activeToolReminders: [],
    });
    for (const reminder of promptAssembly.ephemeralReminderSegments) {
      if (!reminder.id.startsWith("reminder.")) {
        continue;
      }
      const reminderKey = reminder.id.slice("reminder.".length);
      markReminderInjected(session, reminderKey);
    }
    await this.sessionStore.setState(session, session.state);

    const systemPrompt = composeSystemPrompt(promptAssembly);
    const sessionMessages = this.sessionStore.getMessagesForModel(session);
    const modelMessages = toModelMessages(sessionMessages);

    // AI SDK requires at least one message. When no messages exist (e.g. empty send),
    // add a synthetic user message so the model can generate a response.
    if (modelMessages.length === 0) {
      modelMessages.push({ role: "user", content: "Continue." });
    }

    const modelProfile =
      input.modelProfile ?? (session.state.mode === "plan" ? "planner" : "executor");

    const taskManager = new TaskManager(getSessionPaths(session.id).tasksDir, this.spawnEnv);
    const permissionStore = new PermissionStore(session.workspaceRoot, session.id);

    const toolContext: ToolRuntimeContext = {
      workspaceRoot: session.workspaceRoot,
      session,
      sessionStore: this.sessionStore,
      permissionStore,
      taskManager,
      profile: session.state.profile,
      runId,
      declaredTools: normalizeDeclaredTools(session.declaredTools) ?? undefined,
      approvalOverrides: input.approvalOverrides,
      env: this.spawnEnv,
      providerConfig: {
        webSearch: this.modelRouter.getWebSearchConfig(),
        webSearchFallback: this.modelRouter.getWebSearchFallbackConfig(),
      },
      emitEvent: async (type, payload) => {
        await this.callbacks.emitEvent({
          type,
          request_id: undefined,
          session_id: session.id,
          run_id: runId,
          timestamp: nowIso(),
          payload,
        });
      },
      onHumanQuestion: this.callbacks.onHumanQuestion,
      onApproval: this.callbacks.onApproval,
    };

    const tools = createAiToolSet(toolContext);
    const runStartedAtMs = Date.now();
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalReasoningTokens = 0;
    let modelStepCount = 0;
    const webSources = new Set<string>();

    // Extract original task from first user message for loop detection context
    const taskMessage = input.messages.find((m) => m.role === "user");
    const taskDescription =
      typeof taskMessage?.content === "string" ? taskMessage.content : "Unknown task";

    // Initialize loop controller if enabled
    const loopControlEnabled = input.loopControl?.enableLoopDetection ?? false;
    const loopController = loopControlEnabled
      ? new LoopController(
          {
            ...DEFAULT_LOOP_CONTROL_CONFIG,
            periodicCheckInterval:
              input.loopControl?.periodicCheckInterval ??
              DEFAULT_LOOP_CONTROL_CONFIG.periodicCheckInterval,
            maxSafetySteps:
              input.loopControl?.maxSafetySteps ?? DEFAULT_LOOP_CONTROL_CONFIG.maxSafetySteps,
          },
          this.modelRouter.getModel("judge"),
          taskDescription,
        )
      : null;

    // Track loop control state
    let loopControlBreakReason: string | null = null;

    const runModel = async (profile: ModelProfile) => {
      log.debug("Invoking model stream", { profile });
      let stepIndex = 1;
      await this.callbacks.emitEvent({
        type: "run.step.started",
        request_id: undefined,
        session_id: session.id,
        run_id: runId,
        timestamp: nowIso(),
        payload: { step: stepIndex },
      });
      const result = streamText({
        model: this.modelRouter.getModel(profile),
        messages: modelMessages,
        system: systemPrompt,
        tools,
        stopWhen: [stepCountIs(MAX_AGENT_STEPS)],
        onStepFinish: async (stepResult) => {
          const stepData = asRecord(stepResult) ?? {};
          const toolCalls = Array.isArray(stepData.toolCalls) ? stepData.toolCalls : [];
          const toolResults = Array.isArray(stepData.toolResults) ? stepData.toolResults : [];
          modelStepCount += 1;
          const usageRecord = asRecord(stepData.usage);
          const usage = usageRecord
            ? {
                inputTokens:
                  typeof usageRecord.inputTokens === "number" ? usageRecord.inputTokens : 0,
                outputTokens:
                  typeof usageRecord.outputTokens === "number" ? usageRecord.outputTokens : 0,
                reasoningTokens:
                  typeof usageRecord.reasoningTokens === "number" ? usageRecord.reasoningTokens : 0,
              }
            : undefined;
          totalInputTokens += usage?.inputTokens ?? 0;
          totalOutputTokens += usage?.outputTokens ?? 0;
          totalReasoningTokens += usage?.reasoningTokens ?? 0;
          log.debug("Completed model step", {
            profile,
            step: stepIndex,
            finishReason:
              typeof stepData.finishReason === "string" ? stepData.finishReason : undefined,
            toolCallCount: toolCalls.length,
            usage,
          });
          await this.callbacks.emitEvent({
            type: "run.step.model.completed",
            request_id: undefined,
            session_id: session.id,
            run_id: runId,
            timestamp: nowIso(),
            payload: {
              step: stepIndex,
              finish_reason:
                typeof stepData.finishReason === "string" ? stepData.finishReason : undefined,
              tool_call_count: toolCalls.length,
              usage,
            },
          });
          await this.callbacks.emitEvent({
            type: "run.step.completed",
            request_id: undefined,
            session_id: session.id,
            run_id: runId,
            timestamp: nowIso(),
            payload: { step: stepIndex },
          });

          // Emit debug snapshot with internal state for DevTools monitoring
          const activeChain = this.sessionStore.getMessagesForModel(session);
          const activeReminderKeys = Object.entries(session.state.reminders.activeConditions)
            .filter(([, v]) => v)
            .map(([k]) => k);
          const countByStatus = (items: Array<{ status: string }>): Record<string, number> => {
            const counts: Record<string, number> = {
              pending: 0,
              in_progress: 0,
              completed: 0,
              blocked: 0,
            };
            for (const item of items) {
              counts[item.status] = (counts[item.status] ?? 0) + 1;
            }
            return counts;
          };
          await this.callbacks.emitEvent({
            type: "debug.snapshot",
            request_id: undefined,
            session_id: session.id,
            run_id: runId,
            timestamp: nowIso(),
            payload: {
              step_index: stepIndex,
              total_input_tokens: totalInputTokens,
              total_output_tokens: totalOutputTokens,
              total_reasoning_tokens: totalReasoningTokens,
              loop_control: loopController
                ? {
                    tool_call_count: loopController.getToolCallCount(),
                    detector_sequence_length: loopController.getDetectorSequenceLength(),
                  }
                : null,
              context: {
                message_count: Object.keys(session.messages).length,
                active_chain_length: activeChain.length,
                branch_count: Object.keys(session.branches).length,
                compaction_count: session.compactions.length,
                context_replacement_active: session.contextReplacementMessageId !== null,
              },
              prompt: {
                segment_ids: promptAssembly.metadata.segmentIds,
                dropped_segment_ids: promptAssembly.metadata.droppedSegmentIds,
                approx_token_count: promptAssembly.metadata.approxTokenCount,
              },
              agent_state: {
                mode: session.state.mode,
                profile: session.state.profile,
                active_reminders: activeReminderKeys,
                todo_summary: countByStatus(session.state.todos),
                plan_step_summary: countByStatus(session.state.plan.steps),
              },
            },
          });

          for (const toolResult of toolResults) {
            const toolResultRecord = asRecord(toolResult);
            if (!toolResultRecord) {
              continue;
            }

            const toolName =
              typeof toolResultRecord.toolName === "string" ? toolResultRecord.toolName : null;
            const toolCallId =
              typeof toolResultRecord.toolCallId === "string" ? toolResultRecord.toolCallId : null;
            if (!toolName || !toolCallId) {
              continue;
            }

            const output =
              "output" in toolResultRecord ? toolResultRecord.output : toolResultRecord.result;
            for (const source of collectWebSourcesFromToolOutput(toolName, output)) {
              webSources.add(source);
            }

            // Extract tool input from the original tool call for persistence
            const matchingCall = toolCalls.find(
              (tc: Record<string, unknown>) => (tc.toolCallId ?? tc.tool_call_id) === toolCallId,
            );
            const toolInputArgs = matchingCall
              ? (matchingCall.args ?? matchingCall.input ?? {})
              : {};

            const toolMsg = await this.sessionStore.appendMessage(
              session,
              "tool",
              { tool_name: toolName, tool_call_id: toolCallId, input: toolInputArgs, output },
              runId,
            );

            await this.callbacks.emitEvent({
              type: "run.step.tool.call.completed",
              request_id: undefined,
              session_id: session.id,
              run_id: runId,
              timestamp: nowIso(),
              payload: { tool_name: toolName, tool_call_id: toolCallId },
            });

            const isToolError = isToolPolicyViolation(output);

            await this.callbacks.emitEvent({
              type: "tool.call.result",
              request_id: undefined,
              session_id: session.id,
              run_id: runId,
              timestamp: nowIso(),
              payload: {
                tool_name: toolName,
                tool_call_id: toolCallId,
                output,
                message_id: toolMsg.id,
                is_error: isToolError,
              },
            });

            // Process loop control for this tool call
            if (loopController) {
              const inputArgs = matchingCall ? (matchingCall.args ?? matchingCall.input ?? {}) : {};
              const action = await loopController.onToolCall(toolName, inputArgs, output);

              if (action.action === "break") {
                loopControlBreakReason = action.reason;
                log.warn("Loop control triggered break", {
                  reason: action.reason,
                  message: action.message,
                  toolCallCount: loopController.getToolCallCount(),
                });
                // Emit event for observability
                await this.callbacks.emitEvent({
                  type: "run.loop_control.break",
                  request_id: undefined,
                  session_id: session.id,
                  run_id: runId,
                  timestamp: nowIso(),
                  payload: { reason: action.reason, message: action.message },
                });
                // Throw custom error to abort the stream
                throw new LoopControlBreakError(action.reason, action.message);
              }

              if (action.action === "inject_reminder") {
                log.info("Loop control injecting reminder", {
                  reason: action.reason,
                  message: action.message,
                });
                await this.callbacks.emitEvent({
                  type: "run.loop_control.reminder",
                  request_id: undefined,
                  session_id: session.id,
                  run_id: runId,
                  timestamp: nowIso(),
                  payload: { reason: action.reason, message: action.message },
                });
              }
            }
          }

          stepIndex += 1;
        },
        onChunk: async ({ chunk }) => {
          if (this.callbacks.isCancelled(runId)) {
            throw new Error(`Run cancelled: ${runId}`);
          }

          if (chunk.type === "reasoning-delta") {
            await this.callbacks.emitEvent({
              type: "run.reasoning",
              request_id: undefined,
              session_id: session.id,
              run_id: runId,
              timestamp: nowIso(),
              payload: { text: chunk.text },
            });
            return;
          }

          if (chunk.type === "text-delta") {
            await this.callbacks.emitEvent({
              type: "run.step.model.delta",
              request_id: undefined,
              session_id: session.id,
              run_id: runId,
              timestamp: nowIso(),
              payload: { text: chunk.text },
            });
            await this.callbacks.emitEvent({
              type: "run.delta",
              request_id: undefined,
              session_id: session.id,
              run_id: runId,
              timestamp: nowIso(),
              payload: { text: chunk.text },
            });
            return;
          }

          if (chunk.type === "tool-call") {
            await this.callbacks.emitEvent({
              type: "run.step.tool.batch.started",
              request_id: undefined,
              session_id: session.id,
              run_id: runId,
              timestamp: nowIso(),
              payload: {},
            });
            await this.callbacks.emitEvent({
              type: "run.step.tool.call.requested",
              request_id: undefined,
              session_id: session.id,
              run_id: runId,
              timestamp: nowIso(),
              payload: {
                tool_name: chunk.toolName,
                tool_call_id: chunk.toolCallId,
                input: chunk.input,
              },
            });
            await this.callbacks.emitEvent({
              type: "tool.call.requested",
              request_id: undefined,
              session_id: session.id,
              run_id: runId,
              timestamp: nowIso(),
              payload: {
                tool_name: chunk.toolName,
                tool_call_id: chunk.toolCallId,
                input: chunk.input,
              },
            });
          }
        },
      });

      return result;
    };

    let outputText: string;
    let wasLoopControlBreak = false;

    try {
      const result = await runModel(modelProfile);
      outputText = await result.text;
    } catch (firstError) {
      // Check if this was a loop control break (not a real error)
      if (firstError instanceof LoopControlBreakError) {
        wasLoopControlBreak = true;
        outputText = firstError.userMessage;
        loopControlBreakReason = firstError.reason;
        log.info("Run stopped by loop control", {
          reason: firstError.reason,
          message: firstError.userMessage,
        });
      } else if (modelProfile === "fallback") {
        log.error("Fallback-only run failed", { error: firstError });
        throw firstError;
      } else {
        log.warn("Primary model run failed; retrying fallback", {
          profile: modelProfile,
          error: firstError,
        });
        try {
          const fallback = await runModel("fallback");
          outputText = await fallback.text;
        } catch (fallbackError) {
          log.error("Fallback model run failed", { error: fallbackError });
          throw fallbackError;
        }
      }
    }

    outputText = ensureSourcesSection(outputText, Array.from(webSources.values()));

    // Verify completion conditions if not a loop control break
    const completionConditions = input.loopControl?.completionConditions ?? [];
    if (!wasLoopControlBreak && completionConditions.length > 0) {
      // Create task listing function for tasks_complete condition
      const listTasks = async (): Promise<TaskStatus[]> => {
        // Map session todos to TaskStatus format
        return session.state.todos.map((todo, index) => ({
          id: `todo-${index}`,
          subject: todo.content,
          status: todo.status === "blocked" ? "pending" : todo.status,
        }));
      };

      const verification = await verifyConditions(completionConditions, {
        workspaceRoot: session.workspaceRoot,
        listTasks,
        env: this.spawnEnv,
      });

      if (!verification.allMet) {
        const reminderText = formatUnmetConditions(verification.results);
        log.info("Completion conditions not met", {
          unmetCount: verification.results.filter((r) => !r.met).length,
        });
        await this.callbacks.emitEvent({
          type: "run.completion_conditions.unmet",
          request_id: undefined,
          session_id: session.id,
          run_id: runId,
          timestamp: nowIso(),
          payload: {
            conditions: verification.results.map((r) => ({
              type: r.condition.type,
              met: r.met,
              details: r.details,
            })),
            reminder: reminderText,
          },
        });
        // Append the reminder as context for next turn
        outputText = `${outputText}\n\n---\n**Completion Check Failed:**\n${reminderText}`;
      }
    }

    const assistantMsg = await this.sessionStore.appendMessage(
      session,
      "assistant",
      outputText,
      runId,
    );

    session = await this.sessionStore.loadSession(session.id);

    await this.callbacks.emitEvent({
      type: "run.completed",
      request_id: undefined,
      session_id: session.id,
      run_id: runId,
      timestamp: nowIso(),
      payload: {
        text: outputText,
        message_id: assistantMsg.id,
        loop_control_break: wasLoopControlBreak,
        loop_control_reason: loopControlBreakReason,
        metrics: {
          model_step_count: modelStepCount,
          latency_ms_total: Date.now() - runStartedAtMs,
          input_tokens: totalInputTokens,
          output_tokens: totalOutputTokens,
          reasoning_tokens: totalReasoningTokens,
          estimated_cost_usd: estimateCostUsd(totalInputTokens, totalOutputTokens),
          tool_call_count: loopController?.getToolCallCount() ?? null,
        },
      },
    });

    log.info("Run turn completed", {
      textLength: outputText.length,
      modelStepCount,
      wasLoopControlBreak,
      loopControlReason: loopControlBreakReason,
      latencyMs: Date.now() - runStartedAtMs,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      reasoningTokens: totalReasoningTokens,
      estimatedCostUsd: estimateCostUsd(totalInputTokens, totalOutputTokens),
    });

    return { runId, session, text: outputText };
  }
}
