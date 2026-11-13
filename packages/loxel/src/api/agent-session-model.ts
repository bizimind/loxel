/**
 * The agent panel's session model, shared by the server and the renderer: what an agent session
 * shows (transcript, pending interactions, status, settings) and the WebSocket messages on
 * `/ws/agent`. It is independent of how the server talks to the agent (see
 * `src/server/agent/agent-transport.ts`), so a different transport can feed the same UI.
 */

/** What the agent is doing, as the tab and the panel header show it. */
export type AgentStatus =
  | "starting"
  | "idle"
  | "working"
  | "needs_input"
  | "failed"
  /** The session continues in a terminal (`claude --resume`); the panel waits to resume it. */
  | "handed_off";

export const PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "plan",
  "auto",
  "dontAsk",
  "bypassPermissions",
] as const;
export type AgentPermissionMode = (typeof PERMISSION_MODES)[number];

export const PERMISSION_MODE_LABELS: Record<AgentPermissionMode, string> = {
  default: "Ask before edits",
  acceptEdits: "Accept edits",
  plan: "Plan mode",
  auto: "Auto",
  dontAsk: "Don't ask (deny)",
  bypassPermissions: "Bypass permissions",
};

export function isPermissionMode(value: unknown): value is AgentPermissionMode {
  return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value);
}

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AgentEffort = (typeof EFFORT_LEVELS)[number];

export function isEffort(value: unknown): value is AgentEffort {
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}

export interface ToolResult {
  text: string;
  isError: boolean;
}

/**
 * One entry of the transcript. `parentToolUseId` is the subagent (`Agent`/`Task` tool call) that
 * produced the entry, or null for the main conversation.
 */
export type TranscriptItem =
  | {
      kind: "user";
      id: string;
      text: string;
      imageCount: number;
      /** Sent while the agent was busy and not taken in yet. */
      queued?: boolean;
    }
  | {
      kind: "assistant";
      id: string;
      text: string;
      parentToolUseId: string | null;
      streaming?: boolean;
    }
  | {
      kind: "thinking";
      id: string;
      text: string;
      parentToolUseId: string | null;
      streaming?: boolean;
    }
  | {
      kind: "tool";
      /** The tool use id, which its result and its subagent's entries refer to. */
      id: string;
      name: string;
      input: unknown;
      parentToolUseId: string | null;
      result?: ToolResult;
    }
  | { kind: "notice"; id: string; text: string; tone: "info" | "error" };

export interface AgentQuestionOption {
  label: string;
  description: string;
  preview?: string;
}

export interface AgentQuestion {
  /** The question text, which also keys its answer. */
  question: string;
  header: string;
  multiSelect: boolean;
  options: AgentQuestionOption[];
}

/** Where an "always allow" rule is saved. */
export const PERMISSION_DESTINATIONS = [
  "session",
  "localSettings",
  "projectSettings",
  "userSettings",
] as const;
export type PermissionDestination = (typeof PERMISSION_DESTINATIONS)[number];

export const PERMISSION_DESTINATION_LABELS: Record<PermissionDestination, string> = {
  session: "this session",
  localSettings: "this project (just you)",
  projectSettings: "this project (shared)",
  userSettings: "all projects",
};

export function isPermissionDestination(value: unknown): value is PermissionDestination {
  return (
    typeof value === "string" && (PERMISSION_DESTINATIONS as readonly string[]).includes(value)
  );
}

/** An "always allow" choice the agent offered, described for the user. */
export interface PermissionSuggestion {
  id: string;
  /** What it allows, e.g. `Bash(npm test:*)` or `Edit files in /repo/src`. */
  label: string;
  destination: PermissionDestination;
  /** Whether the user may save it somewhere else (rules and directories can, a mode switch cannot). */
  movable: boolean;
}

export type AgentInteraction =
  | { kind: "question"; id: string; questions: AgentQuestion[] }
  | {
      kind: "permission";
      id: string;
      toolName: string;
      /** The agent's own wording of the request, when it gave one. */
      title?: string;
      description?: string;
      decisionReason?: string;
      blockedPath?: string;
      input: unknown;
      suggestions: PermissionSuggestion[];
      /** False when the agent's settings forbid remembering this permission. */
      allowAlways: boolean;
    }
  | { kind: "plan"; id: string; plan: string; planFilePath?: string };

export type InteractionResponse =
  /** `answers` maps question text to the chosen label(s), joined with ", " for multi-select. */
  | { kind: "question"; answers: Record<string, string> }
  | { kind: "question"; dismissed: true }
  | {
      kind: "permission";
      decision: "allow";
      /** Suggestions to apply as well, each optionally saved somewhere else. */
      always?: { id: string; destination?: PermissionDestination }[];
    }
  | { kind: "permission"; decision: "deny"; message?: string; stop?: boolean }
  | { kind: "plan"; decision: "approve"; mode: AgentPermissionMode }
  | { kind: "plan"; decision: "keep_planning"; feedback: string };

export interface AgentCommand {
  name: string;
  description: string;
  argumentHint: string;
}

export interface AgentModel {
  /** What to switch to (an alias such as `sonnet`, or a model id). */
  value: string;
  /** The model id the alias stands for, as the agent reports its current model. */
  resolvedModel?: string;
  displayName: string;
  description: string;
  effortLevels: AgentEffort[];
}

export interface AgentSessionInfo {
  /** The agent's own session id once it has one; used to resume after a restart. */
  sessionId: string | null;
  cwd: string;
  model: string | null;
  effort: AgentEffort | null;
  permissionMode: AgentPermissionMode;
  agentVersion: string | null;
  commands: AgentCommand[];
  models: AgentModel[];
  costUsd: number | null;
  /** Why the session failed, when `status` is `failed`. */
  error: string | null;
}

export interface AgentSnapshot {
  status: AgentStatus;
  info: AgentSessionInfo;
  items: TranscriptItem[];
  interactions: AgentInteraction[];
}

export interface AgentImage {
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  /** Base64 without the data URL prefix. */
  data: string;
}

/** `queue` waits for the current turn to finish; `steer` reaches the agent mid-turn. */
export type AgentDelivery = "queue" | "steer";

/** Client-to-server messages on `/ws/agent`. */
export type AgentClientMessage =
  | {
      type: "attach";
      agentId: string;
      cwd: string;
      /** The agent session to resume when the server has no live session for `agentId`. */
      resumeSessionId?: string;
      /** The session was handed off to a terminal: show it, but do not start it until resumed. */
      handedOff?: boolean;
    }
  | { type: "send"; text: string; images?: AgentImage[]; delivery: AgentDelivery }
  | { type: "interrupt" }
  | { type: "respond"; interactionId: string; response: InteractionResponse }
  | { type: "set_model"; model: string }
  | { type: "set_effort"; effort: AgentEffort }
  | { type: "set_permission_mode"; mode: AgentPermissionMode }
  /** Stop the session here so it can continue in a terminal. */
  | { type: "hand_off" }
  /**
   * Pick the session up again, with whatever happened in the terminal; `fresh` starts a new
   * conversation instead (when the saved one cannot be resumed).
   */
  | { type: "resume"; fresh?: boolean };

/** Server-to-client messages on `/ws/agent`. */
export type AgentServerMessage =
  | { type: "snapshot"; snapshot: AgentSnapshot }
  /** Insert or replace a transcript item by id. */
  | { type: "item"; item: TranscriptItem }
  /** Stream more text into an assistant or thinking item. */
  | { type: "append"; id: string; text: string }
  | { type: "interaction"; interaction: AgentInteraction }
  | { type: "interaction_resolved"; id: string }
  | { type: "status"; status: AgentStatus }
  | { type: "info"; info: AgentSessionInfo }
  /** The session stopped here; `command` continues it in a terminal started in `cwd`. */
  | { type: "handed_off"; command: string; cwd: string };

/** Apply a server message to a snapshot. Pure, shared by the renderer and tests. */
export function applyAgentMessage(snapshot: AgentSnapshot, msg: AgentServerMessage): AgentSnapshot {
  switch (msg.type) {
    case "snapshot":
      return msg.snapshot;
    case "item": {
      const index = snapshot.items.findIndex((item) => item.id === msg.item.id);
      if (index === -1) return { ...snapshot, items: [...snapshot.items, msg.item] };
      const items = snapshot.items.slice();
      items[index] = msg.item;
      return { ...snapshot, items };
    }
    case "append": {
      const index = snapshot.items.findIndex((item) => item.id === msg.id);
      const item = snapshot.items[index];
      if (!item || (item.kind !== "assistant" && item.kind !== "thinking")) return snapshot;
      const items = snapshot.items.slice();
      items[index] = { ...item, text: item.text + msg.text };
      return { ...snapshot, items };
    }
    case "interaction":
      return {
        ...snapshot,
        interactions: [
          ...snapshot.interactions.filter((i) => i.id !== msg.interaction.id),
          msg.interaction,
        ],
      };
    case "interaction_resolved":
      return { ...snapshot, interactions: snapshot.interactions.filter((i) => i.id !== msg.id) };
    case "status":
      return { ...snapshot, status: msg.status };
    case "info":
      return { ...snapshot, info: msg.info };
    case "handed_off":
      return { ...snapshot, status: "handed_off", interactions: [] };
    default: {
      const unknown: never = msg;
      return unknown;
    }
  }
}

export function emptyAgentSnapshot(cwd: string): AgentSnapshot {
  return {
    status: "starting",
    info: {
      sessionId: null,
      cwd,
      model: null,
      effort: null,
      permissionMode: "default",
      agentVersion: null,
      commands: [],
      models: [],
      costUsd: null,
      error: null,
    },
    items: [],
    interactions: [],
  };
}
