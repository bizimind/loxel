import type { TodoItem } from "@bizimind/coding-agent/schemas";
import { create } from "zustand";

import type {
  CodingAgentTimelineItem,
  PendingApproval,
  PendingHumanInput,
  SessionRecordSnapshot,
} from "@/api/coding-agent-model";
import { processProtocolEvent } from "@/api/coding-agent-model";
/**
 * Zustand store for coding agent session state.
 * Global (not scoped) — sessions are keyed by UUID and survive project/worktree switches.
 */
import type { AgentEventPayload, AgentStatus } from "@/api/ws-protocol";
import { deriveAgentStatus } from "@/api/ws-protocol";

/** Max timeline items per session to prevent unbounded DOM growth. */
const MAX_TIMELINE_ITEMS = 2000;

export interface CodingAgentSessionState {
  items: CodingAgentTimelineItem[];
  lastSeq: number;
  codingAgentSessionId: string | null;
  status: AgentStatus;
  pendingHumanInput: PendingHumanInput | null;
  pendingApproval: PendingApproval | null;
  exitCode: number | null;
  isReplaying: boolean;
  /** Maps timeline item IDs to backend SessionMessage IDs for rewind/fork targeting. */
  messageIdMap: Record<string, string>;
  /** Branch metadata from the backend session record. */
  branchInfo: SessionRecordSnapshot | null;
  /** Pending fork operation waiting for user tab choice. */
  pendingFork: { messageId: string } | null;
  /** Message queued to send after the current run completes. */
  queuedMessage: string | null;
  /** Current todo list from the agent. */
  todos: TodoItem[];
}

interface CodingAgentStore {
  sessions: Record<string, CodingAgentSessionState>;

  /** Initialize an empty session entry (idempotent). */
  initSession: (sessionId: string) => void;

  /** Process a protocol event from the server, updating timeline and derived state. */
  processEvent: (sessionId: string, event: AgentEventPayload, seq: number) => void;

  /** Set replaying flag (suppresses auto-scroll during replay). */
  setReplaying: (sessionId: string, replaying: boolean) => void;

  /** Add an optimistic user message to the timeline. */
  /** Add an optimistic user message. Returns the client-generated message ID. */
  addOptimisticUserMessage: (sessionId: string, text: string) => string;

  /** Add a client-side error item without affecting seq-based dedup. */
  addErrorItem: (sessionId: string, message: string) => void;

  /** Update session status (e.g. on agent_exit). */
  setStatus: (sessionId: string, status: AgentStatus, exitCode?: number) => void;

  /** Remove a session entirely from the store. */
  removeSession: (sessionId: string) => void;

  /** Clear timeline items and reset session for replay (e.g., when switching branches). */
  clearTimeline: (sessionId: string) => void;

  /**
   * Rewind to a timeline item.
   * - User messages: exclusive (removes the message, returns body for input draft)
   * - Other items: inclusive (keeps everything up to and including the target)
   * Returns the server message ID to rewind to (or parent for user messages).
   */
  rewindToMessage: (
    sessionId: string,
    timelineItemId: string,
  ) => { rewindTargetId: string | null; messageBody: string | null } | null;

  /** Set pending fork state. */
  startFork: (sessionId: string, messageId: string) => void;

  /** Clear pending fork state. */
  clearFork: (sessionId: string) => void;

  /** Set a queued message to send after the current run completes. */
  setQueuedMessage: (sessionId: string, message: string | null) => void;

  /** Consume and return the queued message (returns null if none). */
  consumeQueuedMessage: (sessionId: string) => string | null;
}

function createEmptySession(): CodingAgentSessionState {
  return {
    items: [],
    lastSeq: 0,
    codingAgentSessionId: null,
    status: "starting",
    pendingHumanInput: null,
    pendingApproval: null,
    exitCode: null,
    isReplaying: false,
    messageIdMap: {},
    branchInfo: null,
    pendingFork: null,
    queuedMessage: null,
    todos: [],
  };
}

/**
 * Rebuild timeline items from a session record's active chain.
 * Used when a forked/resumed session has no local timeline (e.g., new tab for a fork).
 */
type ReplayRole = "system" | "user" | "assistant" | "tool";

function rebuildTimelineFromRecord(record: SessionRecordSnapshot): CodingAgentTimelineItem[] {
  const chain: Array<{ id: string; role: ReplayRole; content: unknown; createdAt: string }> = [];
  let cursor = record.activeMessageId;
  while (cursor) {
    const msg = record.messages[cursor];
    if (!msg) break;
    chain.push(msg);
    cursor = msg.parentMessageId;
  }
  chain.reverse();

  const items: CodingAgentTimelineItem[] = [];
  for (const msg of chain) {
    const contentStr = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    switch (msg.role) {
      case "user":
        items.push({
          id: `replay-${msg.id}`,
          kind: "user",
          title: "",
          body: contentStr,
          timestamp: msg.createdAt,
          messageId: msg.id,
        });
        break;
      case "assistant":
        if (contentStr.trim()) {
          items.push({
            id: `replay-${msg.id}`,
            kind: "assistant",
            title: "",
            body: contentStr,
            timestamp: msg.createdAt,
            messageId: msg.id,
          });
        }
        break;
      case "tool": {
        const parsed =
          typeof msg.content === "object" && msg.content !== null
            ? (msg.content as Record<string, unknown>)
            : null;
        const toolInput =
          parsed?.input !== undefined && parsed.input !== null && typeof parsed.input === "object"
            ? (parsed.input as Record<string, unknown>)
            : {};
        const outputStr =
          parsed?.output !== undefined && parsed.output !== null
            ? typeof parsed.output === "string"
              ? parsed.output
              : JSON.stringify(parsed.output, null, 2)
            : undefined;
        items.push({
          id: `replay-${msg.id}`,
          kind: "tool-call",
          title: String(parsed?.tool_name ?? "Tool"),
          body: "",
          timestamp: msg.createdAt,
          messageId: msg.id,
          toolName: String(parsed?.tool_name ?? "Tool"),
          toolInput,
          toolResult:
            outputStr !== undefined
              ? { content: outputStr, is_error: Boolean(parsed?.is_error) }
              : undefined,
        });
        break;
      }
      case "system":
        // System prompts are not user-facing; intentionally omitted from the timeline.
        break;
      default: {
        const _exhaustive: never = msg.role;
        throw new Error(`Unknown message role: ${String(_exhaustive)}`);
      }
    }
  }
  return items;
}

export const useCodingAgentStore = create<CodingAgentStore>((set) => ({
  sessions: {},

  initSession: (sessionId) => {
    set((state) => {
      if (state.sessions[sessionId]) return state;
      return { sessions: { ...state.sessions, [sessionId]: createEmptySession() } };
    });
  },

  processEvent: (sessionId, event, seq) => {
    set((state) => {
      const session = state.sessions[sessionId];
      if (!session) return state;

      // Dedup by sequence number
      if (seq <= session.lastSeq) return state;

      // Derive status
      const newStatus = deriveAgentStatus(event.type);
      const status = newStatus ?? session.status;

      // Process event into timeline mutations
      const result = processProtocolEvent(event, session.items);

      // Cap timeline items
      let items = result.updatedItems;
      if (items.length > MAX_TIMELINE_ITEMS) {
        items = items.slice(items.length - MAX_TIMELINE_ITEMS);
      }

      const updated: CodingAgentSessionState = {
        ...session,
        items,
        lastSeq: seq,
        status,
        codingAgentSessionId: result.codingAgentSessionId ?? session.codingAgentSessionId,
      };

      // Update pending interactions only if the transform explicitly set them
      if (result.pendingHumanInput !== undefined) {
        updated.pendingHumanInput = result.pendingHumanInput;
      }
      if (result.pendingApproval !== undefined) {
        updated.pendingApproval = result.pendingApproval;
      }

      // Map client user message ID → server message ID (only for user messages)
      if (result.messageReceived) {
        const { clientMessageId, serverMessageId } = result.messageReceived;
        const itemIdx = updated.items.findIndex((i) => i.id === clientMessageId);
        if (itemIdx >= 0) {
          const newItems = [...updated.items];
          newItems[itemIdx] = { ...newItems[itemIdx]!, messageId: serverMessageId };
          updated.items = newItems;
        }
        updated.messageIdMap = { ...updated.messageIdMap, [clientMessageId]: serverMessageId };
      }

      // Update todos if a todo.updated event was processed
      if (result.todos) {
        updated.todos = result.todos;
      }

      // Update branch info if session record was returned (session.got event)
      if (result.sessionRecord) {
        updated.branchInfo = result.sessionRecord;

        // If the timeline is empty but the session has messages (e.g., forked session
        // opened in a new tab), rebuild the timeline from the session record.
        if (updated.items.length === 0 && Object.keys(result.sessionRecord.messages).length > 0) {
          updated.items = rebuildTimelineFromRecord(result.sessionRecord);
          // Populate messageIdMap so rewind/fork can resolve server IDs
          const rebuiltMap: Record<string, string> = {};
          for (const item of updated.items) {
            if (item.messageId) rebuiltMap[item.id] = item.messageId;
          }
          updated.messageIdMap = { ...updated.messageIdMap, ...rebuiltMap };
        }
      }

      return { sessions: { ...state.sessions, [sessionId]: updated } };
    });
  },

  setReplaying: (sessionId, replaying) => {
    set((state) => {
      const session = state.sessions[sessionId];
      if (!session) return state;
      return {
        sessions: { ...state.sessions, [sessionId]: { ...session, isReplaying: replaying } },
      };
    });
  },

  addOptimisticUserMessage: (sessionId, text) => {
    const clientMessageId = `user-${crypto.randomUUID()}`;

    set((state) => {
      const session = state.sessions[sessionId];
      if (!session) return state;

      const userItem: CodingAgentTimelineItem = {
        id: clientMessageId,
        kind: "user",
        title: "",
        body: text,
        timestamp: new Date().toISOString(),
      };

      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...session, items: [...session.items, userItem] },
        },
      };
    });

    return clientMessageId;
  },

  addErrorItem: (sessionId, message) => {
    set((state) => {
      const session = state.sessions[sessionId];
      if (!session) return state;
      const errorItem: CodingAgentTimelineItem = {
        id: `error-${crypto.randomUUID()}`,
        kind: "event",
        title: "Error",
        body: message,
        timestamp: new Date().toISOString(),
      };
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...session, items: [...session.items, errorItem] },
        },
      };
    });
  },

  setStatus: (sessionId, status, exitCode) => {
    set((state) => {
      const session = state.sessions[sessionId];
      if (!session) return state;
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...session, status, exitCode: exitCode ?? session.exitCode },
        },
      };
    });
  },

  removeSession: (sessionId) => {
    set((state) => {
      const { [sessionId]: _, ...rest } = state.sessions;
      return { sessions: rest };
    });
  },

  clearTimeline: (sessionId) => {
    set((state) => {
      const session = state.sessions[sessionId];
      if (!session) return state;
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...session,
            items: [],
            lastSeq: 0,
            status: "starting" as const,
            isReplaying: true,
            pendingHumanInput: null,
            pendingApproval: null,
            pendingFork: null,
            messageIdMap: {},
          },
        },
      };
    });
  },

  rewindToMessage: (sessionId, timelineItemId) => {
    let result: { rewindTargetId: string | null; messageBody: string | null } | null = null;

    set((prev) => {
      const session = prev.sessions[sessionId];
      if (!session) return prev;

      const idx = session.items.findIndex((i) => i.id === timelineItemId);
      if (idx < 0) return prev;

      const item = session.items[idx]!;
      const isUserMessage = item.kind === "user";

      if (isUserMessage) {
        // User messages: exclusive — remove the message, return body for draft input.
        // Rewind target is the parent of this message (the state before it was sent).
        const msgId = session.messageIdMap[timelineItemId];
        let parentId: string | null = null;
        if (msgId && session.branchInfo) {
          parentId = session.branchInfo.messages[msgId]?.parentMessageId ?? null;
        }
        result = { rewindTargetId: parentId, messageBody: item.body };

        return {
          sessions: {
            ...prev.sessions,
            [sessionId]: {
              ...session,
              items: session.items.slice(0, idx),
              lastSeq: 0,
              status: "starting" as const,
              pendingHumanInput: null,
              pendingApproval: null,
              pendingFork: null,
            },
          },
        };
      }

      // Non-user items: inclusive — keep everything up to and including the target.
      // Rewind target is the item's own server message ID.
      const serverId = item.messageId ?? session.messageIdMap[timelineItemId] ?? null;
      result = { rewindTargetId: serverId, messageBody: null };

      return {
        sessions: {
          ...prev.sessions,
          [sessionId]: {
            ...session,
            items: session.items.slice(0, idx + 1),
            lastSeq: 0,
            status: "starting" as const,
            pendingHumanInput: null,
            pendingApproval: null,
            pendingFork: null,
          },
        },
      };
    });

    return result;
  },

  startFork: (sessionId, messageId) => {
    set((state) => {
      const session = state.sessions[sessionId];
      if (!session) return state;
      return {
        sessions: { ...state.sessions, [sessionId]: { ...session, pendingFork: { messageId } } },
      };
    });
  },

  clearFork: (sessionId) => {
    set((state) => {
      const session = state.sessions[sessionId];
      if (!session) return state;
      return { sessions: { ...state.sessions, [sessionId]: { ...session, pendingFork: null } } };
    });
  },

  setQueuedMessage: (sessionId, message) => {
    set((state) => {
      const session = state.sessions[sessionId];
      if (!session) return state;
      return {
        sessions: { ...state.sessions, [sessionId]: { ...session, queuedMessage: message } },
      };
    });
  },

  consumeQueuedMessage: (sessionId) => {
    let message: string | null = null;
    set((state) => {
      const session = state.sessions[sessionId];
      if (!session?.queuedMessage) return state;
      message = session.queuedMessage;
      return { sessions: { ...state.sessions, [sessionId]: { ...session, queuedMessage: null } } };
    });
    return message;
  },
}));
