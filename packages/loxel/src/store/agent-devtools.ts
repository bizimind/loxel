/**
 * Zustand store for Agent DevTools panel state.
 * Stores raw protocol events and derives live metrics from them.
 * Separate from the coding-agent store which transforms events into timeline items.
 */
import { create } from "zustand";

import type { AgentEventPayload } from "@/api/ws-protocol";

/** Max raw events kept per session. Matches server-side MAX_EVENT_BUFFER. */
const MAX_RAW_EVENTS = 5000;

export interface RawEvent {
  seq: number;
  event: AgentEventPayload;
  receivedAt: number;
}

export interface RunMetrics {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  estimatedCostUsd: number | null;
  modelStepCount: number;
  toolCallCount: number | null;
  latencyMsTotal: number | null;
}

export interface DebugSnapshot {
  stepIndex: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalReasoningTokens: number;
  loopControl: { toolCallCount: number; detectorSequenceLength: number } | null;
  context: {
    messageCount: number;
    activeChainLength: number;
    branchCount: number;
    compactionCount: number;
    contextReplacementActive: boolean;
  };
  prompt: { segmentIds: string[]; droppedSegmentIds: string[]; approxTokenCount: number };
  agentState: {
    mode: string;
    profile: string;
    activeReminders: string[];
    todoSummary: Record<string, number>;
    planStepSummary: Record<string, number>;
  };
}

export type DevToolsTab = "events" | "metrics" | "state";

export interface DevToolsSessionState {
  events: RawEvent[];
  lastSeq: number;

  currentRunId: string | null;
  currentRunMetrics: RunMetrics;
  completedRunMetrics: RunMetrics | null;
  totalRuns: number;
  compactionCount: number;

  latestSnapshot: DebugSnapshot | null;

  typeFilter: Set<string>;
  searchQuery: string;
  activeTab: DevToolsTab;
  isPaused: boolean;
}

interface AgentDevToolsStore {
  sessions: Record<string, DevToolsSessionState>;

  initSession: (sessionId: string) => void;
  pushEvent: (sessionId: string, event: AgentEventPayload, seq: number) => void;
  removeSession: (sessionId: string) => void;

  setTypeFilter: (sessionId: string, types: Set<string>) => void;
  setSearchQuery: (sessionId: string, query: string) => void;
  setActiveTab: (sessionId: string, tab: DevToolsTab) => void;
  togglePause: (sessionId: string) => void;
  clearEvents: (sessionId: string) => void;
}

function emptyMetrics(): RunMetrics {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    estimatedCostUsd: null,
    modelStepCount: 0,
    toolCallCount: null,
    latencyMsTotal: null,
  };
}

function createEmptyDevToolsSession(): DevToolsSessionState {
  return {
    events: [],
    lastSeq: 0,
    currentRunId: null,
    currentRunMetrics: emptyMetrics(),
    completedRunMetrics: null,
    totalRuns: 0,
    compactionCount: 0,
    latestSnapshot: null,
    typeFilter: new Set<string>(),
    searchQuery: "",
    activeTab: "events",
    isPaused: false,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" ? v : fallback;
}

function str(v: unknown, fallback = "unknown"): string {
  return typeof v === "string" ? v : fallback;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function numRecord(v: unknown): Record<string, number> {
  if (!isRecord(v)) return {};
  const out: Record<string, number> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === "number") out[k] = val;
  }
  return out;
}

function parseSnapshot(payload: Record<string, unknown>): DebugSnapshot | null {
  if (typeof payload.step_index !== "number") return null;

  const lc = isRecord(payload.loop_control) ? payload.loop_control : null;
  const ctx = isRecord(payload.context) ? payload.context : null;
  const prompt = isRecord(payload.prompt) ? payload.prompt : null;
  const agentState = isRecord(payload.agent_state) ? payload.agent_state : null;

  return {
    stepIndex: payload.step_index,
    totalInputTokens: num(payload.total_input_tokens),
    totalOutputTokens: num(payload.total_output_tokens),
    totalReasoningTokens: num(payload.total_reasoning_tokens),
    loopControl: lc
      ? {
          toolCallCount: num(lc.tool_call_count),
          detectorSequenceLength: num(lc.detector_sequence_length),
        }
      : null,
    context: {
      messageCount: num(ctx?.message_count),
      activeChainLength: num(ctx?.active_chain_length),
      branchCount: num(ctx?.branch_count),
      compactionCount: num(ctx?.compaction_count),
      contextReplacementActive: ctx?.context_replacement_active === true,
    },
    prompt: {
      segmentIds: strArray(prompt?.segment_ids),
      droppedSegmentIds: strArray(prompt?.dropped_segment_ids),
      approxTokenCount: num(prompt?.approx_token_count),
    },
    agentState: {
      mode: str(agentState?.mode),
      profile: str(agentState?.profile),
      activeReminders: strArray(agentState?.active_reminders),
      todoSummary: numRecord(agentState?.todo_summary),
      planStepSummary: numRecord(agentState?.plan_step_summary),
    },
  };
}

export const useAgentDevToolsStore = create<AgentDevToolsStore>((set) => ({
  sessions: {},

  initSession: (sessionId) => {
    set((state) => {
      if (state.sessions[sessionId]) return state;
      return { sessions: { ...state.sessions, [sessionId]: createEmptyDevToolsSession() } };
    });
  },

  pushEvent: (sessionId, event, seq) => {
    set((state) => {
      const session = state.sessions[sessionId];
      if (!session) return state;
      if (seq <= session.lastSeq) return state;

      const rawEvent: RawEvent = { seq, event, receivedAt: Date.now() };
      let events = session.isPaused ? session.events : [...session.events, rawEvent];
      if (events.length > MAX_RAW_EVENTS) {
        events = events.slice(events.length - MAX_RAW_EVENTS);
      }

      let { currentRunId, currentRunMetrics, completedRunMetrics, totalRuns, compactionCount } =
        session;
      let latestSnapshot = session.latestSnapshot;

      // Partial handling over the open-ended agent protocol event types — only a
      // subset drives devtools metrics; all other event types are captured as raw
      // events above and ignored here.
      if (event.type === "run.started") {
        currentRunId = typeof event.run_id === "string" ? event.run_id : null;
        currentRunMetrics = emptyMetrics();
      } else if (event.type === "run.step.model.completed") {
        const usage = isRecord(event.payload.usage) ? event.payload.usage : null;
        if (usage) {
          currentRunMetrics = {
            ...currentRunMetrics,
            inputTokens: currentRunMetrics.inputTokens + num(usage.inputTokens),
            outputTokens: currentRunMetrics.outputTokens + num(usage.outputTokens),
            reasoningTokens: currentRunMetrics.reasoningTokens + num(usage.reasoningTokens),
            modelStepCount: currentRunMetrics.modelStepCount + 1,
          };
        }
      } else if (event.type === "run.completed") {
        const metrics = isRecord(event.payload.metrics) ? event.payload.metrics : null;
        if (metrics) {
          completedRunMetrics = {
            inputTokens: num(metrics.input_tokens),
            outputTokens: num(metrics.output_tokens),
            reasoningTokens: num(metrics.reasoning_tokens),
            estimatedCostUsd:
              typeof metrics.estimated_cost_usd === "number" ? metrics.estimated_cost_usd : null,
            modelStepCount: num(metrics.model_step_count),
            toolCallCount:
              typeof metrics.tool_call_count === "number" ? metrics.tool_call_count : null,
            latencyMsTotal:
              typeof metrics.latency_ms_total === "number" ? metrics.latency_ms_total : null,
          };
        }
        totalRuns += 1;
        currentRunId = null;
      } else if (event.type === "run.failed" || event.type === "run.cancelled") {
        currentRunId = null;
      } else if (event.type === "context.compaction.completed") {
        compactionCount += 1;
      } else if (event.type === "debug.snapshot") {
        latestSnapshot = parseSnapshot(event.payload);
      }

      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...session,
            events,
            lastSeq: seq,
            currentRunId,
            currentRunMetrics,
            completedRunMetrics,
            totalRuns,
            compactionCount,
            latestSnapshot,
          },
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

  setTypeFilter: (sessionId, types) => {
    set((state) => {
      const session = state.sessions[sessionId];
      if (!session) return state;
      return { sessions: { ...state.sessions, [sessionId]: { ...session, typeFilter: types } } };
    });
  },

  setSearchQuery: (sessionId, query) => {
    set((state) => {
      const session = state.sessions[sessionId];
      if (!session) return state;
      return { sessions: { ...state.sessions, [sessionId]: { ...session, searchQuery: query } } };
    });
  },

  setActiveTab: (sessionId, tab) => {
    set((state) => {
      const session = state.sessions[sessionId];
      if (!session) return state;
      return { sessions: { ...state.sessions, [sessionId]: { ...session, activeTab: tab } } };
    });
  },

  togglePause: (sessionId) => {
    set((state) => {
      const session = state.sessions[sessionId];
      if (!session) return state;
      return {
        sessions: { ...state.sessions, [sessionId]: { ...session, isPaused: !session.isPaused } },
      };
    });
  },

  clearEvents: (sessionId) => {
    set((state) => {
      const session = state.sessions[sessionId];
      if (!session) return state;
      return { sessions: { ...state.sessions, [sessionId]: { ...session, events: [] } } };
    });
  },
}));
