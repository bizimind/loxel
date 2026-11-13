/**
 * The agent panel's model, independent of how the agent is driven: a transport (today the Claude
 * Code stream-json client in `src/server/agent/`) turns what the agent says into
 * {@link AgentEvent}s, and {@link applyAgentEvent} folds them into an {@link AgentState}. The server
 * keeps the state for every session and sends it whole on attach, then each event; the renderer
 * folds the same events with the same function, so both sides always agree.
 */
import { z } from "zod";

/** What the session is doing, as the tab and the sidebar show it. */
export type AgentStatus = "starting" | "idle" | "working" | "needs_input" | "failed" | "exited";

const PermissionModeSchema = z.enum([
  "default",
  "acceptEdits",
  "plan",
  "auto",
  "dontAsk",
  "bypassPermissions",
]);

export type AgentPermissionMode = z.infer<typeof PermissionModeSchema>;

export const AGENT_PERMISSION_MODES: readonly AgentPermissionMode[] = PermissionModeSchema.options;

export function isAgentPermissionMode(value: unknown): value is AgentPermissionMode {
  return PermissionModeSchema.safeParse(value).success;
}

export interface AgentCommand {
  /** Without the leading slash. */
  name: string;
  description: string;
  argumentHint: string;
}

/** The pickable models: the catalog without its "default" alias, which repeats one of them. */
export function pickableModels(models: readonly AgentModel[]): readonly AgentModel[] {
  return models.filter((m) => m.value !== "default");
}

/** The catalog entry the session's model is: matched by alias or by the id an alias stands for. */
export function currentModel(state: AgentState): AgentModel | null {
  const id = state.model;
  if (!id) return null;
  // A pickable entry first, so the menu can check it; then any, the "default" alias included.
  for (const models of [pickableModels(state.models), state.models]) {
    const found = models.find((m) => m.value === id) ?? models.find((m) => m.resolvedModel === id);
    if (found) return found;
  }
  return null;
}

/**
 * A model's concrete name, such as "Opus 5.5": the catalog's description starts with it
 * ("Opus 5.5 · Best for everyday, complex tasks"), where its display name may be an alias.
 */
export function modelName(model: AgentModel): string {
  const named = model.description.split(" · ")[0]?.trim();
  return named || model.displayName;
}

/** The session's model as the composer shows it, or null until it is known. */
export function modelLabel(state: AgentState): string | null {
  const model = currentModel(state);
  if (model) return modelName(model);
  return state.model ? modelIdName(state.model) : null;
}

/** A name for a model id before the catalog arrives: `claude-opus-5-5` → "Opus 5.5". */
export function modelIdName(id: string): string {
  const match = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(id);
  if (match)
    return `${match[1]!.charAt(0).toUpperCase()}${match[1]!.slice(1)} ${match[2]}.${match[3]}`;
  return id.charAt(0).toUpperCase() + id.slice(1);
}

export interface AgentModel {
  /** What `set_model` takes: an alias (`opus`) or a full model id. */
  value: string;
  /** The model id an alias stands for, which the session reports as its model. */
  resolvedModel: string | null;
  displayName: string;
  description: string;
  effortLevels: readonly string[];
}

/** How a "don't ask again" answer would change the permission rules, as the agent suggests it. */
export interface PermissionSuggestion {
  /** The agent's own update object, sent back unchanged (with `destination` replaced) to apply it. */
  update: Record<string, unknown>;
  /** What it does, for the button: `Bash(npm --version)`, or the mode it switches to. */
  label: string;
  /** Where the agent would save it: `session`, `localSettings`, `projectSettings`, `userSettings`. */
  destination: string;
}

export interface AgentQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: readonly { label: string; description: string }[];
}

/** Something the agent waits on the user for. */
export type AgentRequest =
  | {
      kind: "permission";
      requestId: string;
      /** The tool's name, as rules and summaries know it (`Bash`, `mcp__server__tool`). */
      toolName: string;
      /** What the agent calls it in its dialogs. */
      displayName: string;
      toolUseId: string;
      input: Record<string, unknown>;
      /** The agent's own one-line account of the call; the input is what actually runs. */
      description?: string;
      /** Why it asks rather than runs. */
      reason?: string;
      suggestions: readonly PermissionSuggestion[];
      /** Offer no "don't ask again": accepting would save a rule broader than the ask. */
      suppressAlwaysAllow: boolean;
      /** Do not preselect approve: the ask must not be one stray keystroke away. */
      defaultToNo: boolean;
    }
  | {
      kind: "question";
      requestId: string;
      toolUseId: string;
      input: Record<string, unknown>;
      questions: readonly AgentQuestion[];
    }
  | {
      kind: "plan";
      requestId: string;
      toolUseId: string;
      input: Record<string, unknown>;
      plan: string;
      planFilePath?: string;
    };

/** One entry of the transcript. */
export type TranscriptItem =
  | { kind: "user"; id: string; text: string; imageCount: number; queued: boolean }
  | { kind: "text"; id: string; text: string; streaming: boolean; parentToolUseId: string | null }
  | {
      kind: "thinking";
      id: string;
      text: string;
      streaming: boolean;
      parentToolUseId: string | null;
    }
  | {
      kind: "tool";
      /** The tool_use id, which its result and any subagent's messages refer to. */
      id: string;
      name: string;
      input: unknown;
      result: { text: string; isError: boolean } | null;
      parentToolUseId: string | null;
    }
  | { kind: "notice"; id: string; level: "info" | "error"; text: string };

export interface ContextUsage {
  percentage: number;
  totalTokens: number;
  maxTokens: number;
}

export interface AgentState {
  /** The agent's own session id, which `--resume` takes. */
  sessionId: string | null;
  agentVersion: string | null;
  /** What the agent's turn is doing; {@link agentDisplayStatus} adds pending requests. */
  status: AgentStatus;
  model: string | null;
  effort: string | null;
  permissionMode: AgentPermissionMode | null;
  /** Protocol features the running agent advertises; features gate on them. */
  capabilities: readonly string[];
  commands: readonly AgentCommand[];
  models: readonly AgentModel[];
  items: readonly TranscriptItem[];
  pending: readonly AgentRequest[];
  contextUsage: ContextUsage | null;
  /** Total cost the agent reported for this process, in USD. */
  costUsd: number;
  /** Why the process stopped or failed, when it did. */
  error: string | null;
  /** The session continues in a terminal; this panel resumes it on request. */
  handedOff: boolean;
}

export const INITIAL_AGENT_STATE: AgentState = {
  sessionId: null,
  agentVersion: null,
  status: "starting",
  model: null,
  effort: null,
  permissionMode: null,
  capabilities: [],
  commands: [],
  models: [],
  items: [],
  pending: [],
  contextUsage: null,
  costUsd: 0,
  error: null,
  handedOff: false,
};

export type AgentEvent =
  | {
      type: "session";
      sessionId: string;
      agentVersion: string;
      model: string;
      permissionMode: AgentPermissionMode | null;
      capabilities: readonly string[];
    }
  /** The commands and models the agent offers; a field left out keeps what the state has. */
  | { type: "catalog"; commands?: readonly AgentCommand[]; models?: readonly AgentModel[] }
  | { type: "status"; status: AgentStatus }
  | { type: "permission_mode"; mode: AgentPermissionMode }
  | { type: "model"; model: string }
  | { type: "effort"; effort: string }
  | { type: "user_message"; id: string; text: string; imageCount: number; queued: boolean }
  /** A queued user message the agent has taken into a turn. */
  | { type: "user_message_delivered"; id: string }
  /** Streamed text for a text or thinking item; creates the item on its first delta. */
  | {
      type: "delta";
      id: string;
      kind: "text" | "thinking";
      text: string;
      parentToolUseId: string | null;
    }
  /** A finished item; replaces a streamed one with the same id. */
  | { type: "item"; item: TranscriptItem }
  | { type: "tool_result"; toolUseId: string; text: string; isError: boolean }
  | { type: "request"; request: AgentRequest }
  | { type: "request_resolved"; requestId: string }
  | { type: "turn_result"; isError: boolean; costUsd: number; errorText: string | null }
  | { type: "context_usage"; usage: ContextUsage }
  | { type: "handed_off"; handedOff: boolean }
  | { type: "exited"; error: string | null };

/** What the tab shows: a session waiting on an answer needs input whatever its turn is doing. */
export function agentDisplayStatus(state: AgentState): AgentStatus {
  return state.pending.length > 0 && state.status !== "exited" && state.status !== "failed"
    ? "needs_input"
    : state.status;
}

function upsertItem(items: readonly TranscriptItem[], item: TranscriptItem): TranscriptItem[] {
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index === -1) return [...items, item];
  const next = items.slice();
  next[index] = item;
  return next;
}

function updateItem(
  items: readonly TranscriptItem[],
  id: string,
  update: (item: TranscriptItem) => TranscriptItem,
): readonly TranscriptItem[] {
  const index = items.findIndex((item) => item.id === id);
  if (index === -1) return items;
  const next = items.slice();
  next[index] = update(items[index]!);
  return next;
}

/** Folds one event into the state. Pure: the server and the renderer both run it. */
export function applyAgentEvent(state: AgentState, event: AgentEvent): AgentState {
  switch (event.type) {
    case "session":
      return {
        ...state,
        sessionId: event.sessionId,
        agentVersion: event.agentVersion,
        model: event.model,
        permissionMode: event.permissionMode ?? state.permissionMode,
        capabilities: event.capabilities,
      };
    case "catalog":
      return {
        ...state,
        commands: event.commands ?? state.commands,
        models: event.models ?? state.models,
      };
    case "status":
      return { ...state, status: event.status };
    case "permission_mode":
      return { ...state, permissionMode: event.mode };
    case "model":
      return { ...state, model: event.model };
    case "effort":
      return { ...state, effort: event.effort };
    case "user_message":
      return {
        ...state,
        items: upsertItem(state.items, {
          kind: "user",
          id: event.id,
          text: event.text,
          imageCount: event.imageCount,
          queued: event.queued,
        }),
      };
    case "user_message_delivered":
      return {
        ...state,
        items: updateItem(state.items, event.id, (item) =>
          item.kind === "user" ? { ...item, queued: false } : item,
        ),
      };
    case "delta": {
      const existing = state.items.find((item) => item.id === event.id);
      if (existing && (existing.kind === "text" || existing.kind === "thinking")) {
        return {
          ...state,
          items: updateItem(state.items, event.id, () => ({
            ...existing,
            text: existing.text + event.text,
          })),
        };
      }
      return {
        ...state,
        items: [
          ...state.items,
          {
            kind: event.kind,
            id: event.id,
            text: event.text,
            streaming: true,
            parentToolUseId: event.parentToolUseId,
          },
        ],
      };
    }
    case "item":
      return { ...state, items: upsertItem(state.items, event.item) };
    case "tool_result":
      return {
        ...state,
        items: updateItem(state.items, event.toolUseId, (item) =>
          item.kind === "tool"
            ? { ...item, result: { text: event.text, isError: event.isError } }
            : item,
        ),
      };
    case "request": {
      const pending = [
        ...state.pending.filter((r) => r.requestId !== event.request.requestId),
        event.request,
      ];
      return { ...state, pending };
    }
    case "request_resolved":
      return { ...state, pending: state.pending.filter((r) => r.requestId !== event.requestId) };
    case "turn_result":
      return {
        ...state,
        costUsd: event.costUsd,
        // Streaming never outlives its turn: an interrupted block keeps the text it got.
        items: [
          ...state.items.map((item) =>
            (item.kind === "text" || item.kind === "thinking") && item.streaming
              ? { ...item, streaming: false }
              : item,
          ),
          ...(event.isError && event.errorText
            ? [
                {
                  kind: "notice" as const,
                  id: `turn-error-${state.items.length}`,
                  level: "error" as const,
                  text: event.errorText,
                },
              ]
            : []),
        ],
      };
    case "context_usage":
      return { ...state, contextUsage: event.usage };
    case "handed_off":
      if (!event.handedOff) return { ...state, handedOff: false };
      // The process is gone: nothing it asked can be answered here, and nothing streams.
      return {
        ...state,
        handedOff: true,
        pending: [],
        items: state.items.map((item) =>
          (item.kind === "text" || item.kind === "thinking") && item.streaming
            ? { ...item, streaming: false }
            : item,
        ),
      };
    case "exited":
      return {
        ...state,
        status: event.error ? "failed" : "exited",
        error: event.error,
        pending: [],
      };
    default: {
      // An event a newer server sends that this renderer does not know changes nothing.
      const _unknown: never = event;
      return state;
    }
  }
}

// ---------------------------------------------------------------------------
// The agent socket: `/ws/agent?id=<agentId>`, one per mounted agent panel.
// ---------------------------------------------------------------------------

/** Where a "don't ask again" rule is saved. */
const DestinationSchema = z.enum(["session", "localSettings", "projectSettings", "userSettings"]);
export type PermissionDestination = z.infer<typeof DestinationSchema>;

/** Base64 of a pasted image, capped well under the socket's message limit. */
export const MAX_IMAGE_BASE64_LENGTH = 7_000_000;

/** An image attached to a prompt, base64 without the data-URL prefix. */
const AgentImageSchema = z.object({
  mediaType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  data: z.string().max(MAX_IMAGE_BASE64_LENGTH),
});
export type AgentImage = z.infer<typeof AgentImageSchema>;

/** The user's answer to an {@link AgentRequest}. */
const AgentResponseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("permission"),
    allow: z.boolean(),
    /**
     * The request's suggestions to apply, by index, each at the destination the user picked. The
     * server builds the rules from its own copy of the request, so a client can only accept what
     * the agent suggested.
     */
    alwaysAllow: z
      .array(z.object({ index: z.number().int().nonnegative(), destination: DestinationSchema }))
      .optional(),
    /** Why not, for the agent (deny only). */
    message: z.string().optional(),
  }),
  z.object({
    kind: z.literal("question"),
    /** Answers by question text: one label, labels joined by ", ", or free text. */
    answers: z.record(z.string(), z.string()),
  }),
  z.object({
    kind: z.literal("plan"),
    approve: z.boolean(),
    /** The mode to continue in once approved. */
    mode: PermissionModeSchema.optional(),
    /** What to change, when the user keeps planning. */
    feedback: z.string().optional(),
  }),
]);
export type AgentResponse = z.infer<typeof AgentResponseSchema>;

const AgentClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("attach"),
    /** The panel's worktree, where the agent runs. */
    worktreePath: z.string(),
    /** The agent session the panel showed before, to resume after a restart. */
    resumeSessionId: z.string().optional(),
    /** The last sequence number the client applied; it only needs the events after it. */
    sinceSeq: z.number().int().nonnegative().optional(),
    /** The session instance `sinceSeq` counts in; any other instance sends a snapshot. */
    instanceId: z.string().optional(),
  }),
  z.object({
    type: z.literal("send"),
    id: z.uuid(),
    text: z.string(),
    images: z.array(AgentImageSchema).optional(),
    /** `queue` waits for the running turn; `steer` folds into it now. */
    delivery: z.enum(["queue", "steer"]),
  }),
  z.object({ type: z.literal("interrupt") }),
  z.object({ type: z.literal("respond"), requestId: z.string(), response: AgentResponseSchema }),
  z.object({ type: z.literal("set_permission_mode"), mode: PermissionModeSchema }),
  z.object({ type: z.literal("set_model"), model: z.string() }),
  z.object({ type: z.literal("set_effort"), effort: z.string() }),
  z.object({ type: z.literal("refresh_context_usage") }),
  /** Stop the process so the session can continue in a terminal. */
  z.object({ type: z.literal("hand_off") }),
  /** Start the process again on the same session, after a hand-off or an exit. */
  z.object({ type: z.literal("resume") }),
  /** The panel closed: stop the process for good. */
  z.object({ type: z.literal("destroy") }),
]);
export type AgentClientMessage = z.infer<typeof AgentClientMessageSchema>;

/** A message from an agent panel, or null if it is not one. */
export function parseAgentClientMessage(value: unknown): AgentClientMessage | null {
  const result = AgentClientMessageSchema.safeParse(value);
  return result.success ? result.data : null;
}

export type AgentServerMessage =
  /** `instanceId` names this server session's numbering; a restarted server has a new one. */
  | { type: "snapshot"; instanceId: string; seq: number; state: AgentState }
  | { type: "event"; seq: number; event: AgentEvent }
  | { type: "error"; message: string };
