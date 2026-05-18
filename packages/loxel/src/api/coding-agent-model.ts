/**
 * Pure functions to convert coding-agent protocol events into renderable timeline items.
 */
import type { PlanStep, SessionRecord, TodoItem } from "@bizimind/coding-agent/schemas";
import { planStepSchema, todoItemSchema } from "@bizimind/coding-agent/schemas";
import { z } from "zod";

import type { AgentEventPayload } from "@/api/ws-protocol";

export interface CodingAgentTimelineItem {
  id: string;
  kind: "user" | "assistant" | "reasoning" | "tool-call" | "tool-result" | "plan" | "event";
  title: string;
  body: string;
  timestamp: string;
  /** Backend SessionMessage.id — set after session.got correlation. Used for rewind/fork targeting. */
  messageId?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: { content: string; is_error?: boolean };
  /** Structured plan steps — set on plan timeline items. */
  planSteps?: PlanStep[];
}

export interface CodingAgentQuestionOption {
  label: string;
  description: string;
}

export interface CodingAgentQuestion {
  id: string;
  question: string;
  header: string;
  options: CodingAgentQuestionOption[];
  multiSelect?: boolean;
}

export interface PendingHumanInput {
  runId: string;
  pendingKey: string;
  questions: CodingAgentQuestion[];
}

export interface PendingApproval {
  runId: string;
  pendingKey: string;
  toolName: string;
  reason: string;
  options: string[];
  input?: Record<string, unknown>;
}

/**
 * Process a protocol event and return mutations for the session state.
 * Returns new timeline items to add/update and any pending interactions.
 */
/** Subset of SessionRecord fields needed for branch info and message ID correlation. */
export type SessionRecordSnapshot = Pick<
  SessionRecord,
  "id" | "activeBranchId" | "activeMessageId" | "branches" | "branchHeads" | "messages" | "lineage"
>;

export function processProtocolEvent(
  event: AgentEventPayload,
  items: CodingAgentTimelineItem[],
): {
  updatedItems: CodingAgentTimelineItem[];
  pendingHumanInput?: PendingHumanInput | null;
  pendingApproval?: PendingApproval | null;
  codingAgentSessionId?: string;
  sessionRecord?: SessionRecordSnapshot;
  /** Maps a client-generated message ID to its server-assigned ID. */
  messageReceived?: { clientMessageId: string; serverMessageId: string };
  /** Updated todo list from a todo.updated event. */
  todos?: TodoItem[];
} {
  const result: ReturnType<typeof processProtocolEvent> = { updatedItems: items };
  const p = event.payload;

  switch (event.type) {
    case "session.started":
    case "session.resumed":
    case "session.rewound":
      result.codingAgentSessionId = event.session_id;
      // Skip adding timeline items for session lifecycle events
      break;

    case "session.got": {
      const sessionData = p.session;
      if (
        sessionData &&
        typeof sessionData === "object" &&
        "branches" in sessionData &&
        "messages" in sessionData &&
        "activeBranchId" in sessionData
      ) {
        result.sessionRecord = sessionData as SessionRecordSnapshot;
      }
      break;
    }

    case "session.forked":
      // Handled directly in CodingAgentPanel's event subscription
      break;

    case "message.received": {
      const clientId = p.client_message_id;
      const serverId = p.server_message_id;
      console.log("[processEvent] message.received", { clientId, serverId });
      if (typeof clientId === "string" && typeof serverId === "string") {
        result.messageReceived = { clientMessageId: clientId, serverMessageId: serverId };
      }
      break;
    }

    case "run.started":
      break;

    case "run.completed": {
      // Set messageId on the assistant item from the run's final message
      const assistantMsgId = typeof p.message_id === "string" ? p.message_id : undefined;
      console.log("[processEvent] run.completed", { assistantMsgId, payload: p });
      if (assistantMsgId) {
        // Find the last assistant item and tag it with the server message ID
        for (let i = items.length - 1; i >= 0; i--) {
          if (items[i]!.kind === "assistant" && !items[i]!.messageId) {
            console.log("[processEvent] tagging assistant item", {
              idx: i,
              id: items[i]!.id,
              assistantMsgId,
            });
            const updated = [...items];
            updated[i] = { ...updated[i]!, messageId: assistantMsgId };
            result.updatedItems = updated;
            break;
          }
        }
      }
      break;
    }

    case "run.failed":
      result.updatedItems = [
        ...items,
        {
          id: makeId(event),
          kind: "event",
          title: "Error",
          body: String(p.message ?? "Run failed"),
          timestamp: event.timestamp,
        },
      ];
      break;

    case "run.cancelled":
      result.updatedItems = [...items, makeEventItem(event, "Run cancelled")];
      break;

    case "run.reasoning": {
      // Append reasoning delta to the most recent reasoning item, or create one
      const reasoningText = String(p.text ?? "");
      if (!reasoningText) break;

      const lastReasoningIdx = findLastItemIdx(items, "reasoning");
      if (lastReasoningIdx >= 0) {
        const updated = [...items];
        updated[lastReasoningIdx] = {
          ...updated[lastReasoningIdx]!,
          body: updated[lastReasoningIdx]!.body + reasoningText,
        };
        result.updatedItems = updated;
      } else {
        // Use a counter suffix to ensure unique keys when multiple reasoning blocks
        // occur within the same run (e.g., thinking between tool-call steps)
        const reasoningCount = items.filter((i) => i.kind === "reasoning").length;
        result.updatedItems = [
          ...items,
          {
            id: `reasoning-${event.run_id ?? event.timestamp}-${reasoningCount}`,
            kind: "reasoning",
            title: "Reasoning",
            body: reasoningText,
            timestamp: event.timestamp,
          },
        ];
      }
      break;
    }

    case "run.delta": {
      // Append text delta to the most recent assistant item, or create one
      const text = String(p.delta ?? p.text ?? "");
      if (!text) break;

      const lastIdx = findLastAssistantIdx(items);
      if (lastIdx >= 0) {
        // Clone only the affected item
        const updated = [...items];
        updated[lastIdx] = { ...updated[lastIdx]!, body: updated[lastIdx]!.body + text };
        result.updatedItems = updated;
      } else {
        result.updatedItems = [
          ...items,
          {
            id: `assistant-${event.run_id ?? event.timestamp}`,
            kind: "assistant",
            title: "",
            body: text,
            timestamp: event.timestamp,
          },
        ];
      }
      break;
    }

    case "tool.call.requested":
      result.updatedItems = [
        ...items,
        {
          id: String(p.tool_call_id ?? makeId(event)),
          kind: "tool-call",
          title: String(p.tool_name ?? "Tool"),
          body: "",
          timestamp: event.timestamp,
          toolName: String(p.tool_name ?? ""),
          toolInput: (p.input as Record<string, unknown>) ?? {},
        },
      ];
      break;

    case "tool.call.result": {
      const toolCallId = String(p.tool_call_id ?? "");
      const outputStr = stringifyValue(p.output);
      const serverMsgId = typeof p.message_id === "string" ? p.message_id : undefined;
      console.log("[processEvent] tool.call.result", { toolCallId, serverMsgId, payload: p });
      const idx = items.findIndex((i) => i.id === toolCallId && i.kind === "tool-call");
      if (idx >= 0) {
        console.log("[processEvent] tagging tool item", { idx, id: items[idx]!.id, serverMsgId });
        const updated = [...items];
        updated[idx] = {
          ...updated[idx]!,
          toolResult: { content: outputStr, is_error: Boolean(p.is_error) },
          messageId: serverMsgId ?? updated[idx]!.messageId,
        };
        result.updatedItems = updated;
      } else {
        // No matching call — add as standalone result
        result.updatedItems = [
          ...items,
          {
            id: makeId(event),
            kind: "tool-result",
            title: String(p.tool_name ?? "Tool"),
            body: outputStr,
            timestamp: event.timestamp,
            toolName: String(p.tool_name ?? ""),
            toolResult: { content: outputStr, is_error: Boolean(p.is_error) },
          },
        ];
      }
      break;
    }

    case "human.input.requested": {
      const questions = Array.isArray(p.questions)
        ? parseQuestions(p.questions)
        : [
            {
              id: String(p.key ?? "q"),
              question: String(p.question ?? p.tool_name ?? "Input required"),
              header: "",
              options: Array.isArray(p.options) ? parseQuestionOptions(p.options) : [],
            },
          ];
      result.pendingHumanInput = {
        runId: event.run_id ?? "",
        pendingKey: String(p.key ?? ""),
        questions,
      };
      break;
    }

    case "approval.requested":
      result.pendingApproval = {
        runId: event.run_id ?? "",
        pendingKey: String(p.key ?? ""),
        toolName: String(p.tool_name ?? ""),
        reason: String(p.reason ?? ""),
        options: Array.isArray(p.options) ? p.options.map(String) : [],
        input:
          typeof p.input === "object" && p.input !== null
            ? (p.input as Record<string, unknown>)
            : undefined,
      };
      break;

    case "human.input.response":
      result.pendingHumanInput = null;
      break;

    case "approval.granted":
    case "approval.denied":
      result.pendingApproval = null;
      break;

    case "plan.mode.entered":
      result.updatedItems = [...items, makeEventItem(event, "Entered plan mode")];
      break;

    case "plan.mode.exited":
      result.updatedItems = [
        ...items,
        makeEventItem(event, p.approved ? "Plan approved — executing" : "Exited plan mode"),
      ];
      break;

    case "plan.updated": {
      const parsedSteps = z.array(planStepSchema).safeParse(p.steps);
      const steps = parsedSteps.success ? parsedSteps.data : [];
      // Find existing plan item (stable ID) or create one
      const planIdx = items.findIndex((i) => i.id === "plan-current");
      if (planIdx >= 0) {
        const updated = [...items];
        updated[planIdx] = { ...updated[planIdx]!, planSteps: steps };
        result.updatedItems = updated;
      } else {
        result.updatedItems = [
          ...items,
          {
            id: "plan-current",
            kind: "plan",
            title: "Plan",
            body: "",
            timestamp: event.timestamp,
            planSteps: steps,
          },
        ];
      }
      break;
    }

    case "plan.step.changed": {
      // Update the step status in the existing plan item
      const planItem = items.find((i) => i.id === "plan-current");
      if (planItem?.planSteps) {
        const stepId = String(p.step_id ?? "");
        const toStatus = String(p.to ?? "");
        const validStatuses = new Set(["pending", "in_progress", "completed", "blocked"]);
        if (validStatuses.has(toStatus)) {
          const updatedSteps = planItem.planSteps.map((s) =>
            s.id === stepId
              ? { ...s, status: toStatus as "pending" | "in_progress" | "completed" | "blocked" }
              : s,
          );
          const updated = items.map((i) =>
            i.id === "plan-current" ? { ...i, planSteps: updatedSteps } : i,
          );
          result.updatedItems = updated;
        }
      }
      break;
    }

    case "plan.completed":
      result.updatedItems = [...items, makeEventItem(event, "All plan steps completed")];
      break;

    case "todo.updated": {
      const parsedTodos = z.array(todoItemSchema).safeParse(p.todos);
      if (parsedTodos.success) {
        result.todos = parsedTodos.data;
      }
      break;
    }

    default:
      // Ignore unknown event types silently
      break;
  }

  return result;
}

/** Convert a value to a displayable string, JSON-serializing objects instead of `[object Object]`. */
function stringifyValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function makeId(event: AgentEventPayload): string {
  return `${event.type}-${event.run_id ?? ""}-${event.timestamp}-${event.request_id ?? ""}`;
}

function makeEventItem(event: AgentEventPayload, title: string): CodingAgentTimelineItem {
  return { id: makeId(event), kind: "event", title, body: "", timestamp: event.timestamp };
}

/** Find the last item of the given kind, but only if it's the very last item (no boundary crossing). */
function findLastItemIdx(
  items: CodingAgentTimelineItem[],
  kind: CodingAgentTimelineItem["kind"],
): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]!.kind === kind) return i;
    // Stop searching past any non-matching content to avoid concatenating
    // separate responses across tool call / event boundaries
    return -1;
  }
  return -1;
}

function findLastAssistantIdx(items: CodingAgentTimelineItem[]): number {
  return findLastItemIdx(items, "assistant");
}

/** Safely parse an array of question objects from untrusted protocol data. */
function parseQuestions(raw: unknown[]): CodingAgentQuestion[] {
  return raw.map((item) => {
    const q =
      item !== undefined && item !== null && typeof item === "object"
        ? (item as Record<string, unknown>)
        : {};
    return {
      id: String(q.id ?? "q"),
      question: String(q.question ?? ""),
      header: String(q.header ?? ""),
      options: Array.isArray(q.options) ? parseQuestionOptions(q.options) : [],
      multiSelect: typeof q.multiSelect === "boolean" ? q.multiSelect : undefined,
    };
  });
}

/** Safely parse an array of question option objects from untrusted protocol data. */
function parseQuestionOptions(raw: unknown[]): CodingAgentQuestionOption[] {
  return raw.map((item) => {
    const o =
      item !== undefined && item !== null && typeof item === "object"
        ? (item as Record<string, unknown>)
        : {};
    return { label: String(o.label ?? ""), description: String(o.description ?? "") };
  });
}
