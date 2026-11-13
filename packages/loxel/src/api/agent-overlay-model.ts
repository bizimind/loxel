/**
 * The agent overlay's shared model: what the server knows about a coding agent running in a
 * terminal (its session, state, pending interaction and transcript), and what the renderer can ask
 * it to do there. The agent is the same process the terminal shows; the overlay only reads its
 * hooks and transcript and types into its PTY. See docs/AGENT_OVERLAY.md.
 */
import { z } from "zod";

/** What the agent is doing, from its hooks. */
export const AgentStateSchema = z.enum(["working", "needs-input", "idle", "failed", "ended"]);
export type AgentState = z.infer<typeof AgentStateSchema>;

/** Claude Code's permission modes, as its hooks and transcript name them. */
export const AgentPermissionModeSchema = z.enum([
  "default",
  "acceptEdits",
  "plan",
  "auto",
  "bypassPermissions",
  "dontAsk",
]);
export type AgentPermissionMode = z.infer<typeof AgentPermissionModeSchema>;

/** A JSON value from the agent (a tool's input, a permission suggestion), passed on unread. */
export type AgentJson =
  | string
  | number
  | boolean
  | null
  | readonly AgentJson[]
  | { readonly [key: string]: AgentJson };

export interface AgentQuestion {
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
}

/**
 * Something the agent is waiting on the user for. `id` is the tool use it belongs to, or the hook
 * event's arrival when the agent gave none.
 */
export type AgentInteraction =
  | {
      kind: "permission";
      id: string;
      toolName: string;
      toolInput: AgentJson;
      /** What "always allow" would add, as the agent suggests it (rules and their destination). */
      suggestions: AgentJson[];
    }
  | { kind: "question"; id: string; questions: AgentQuestion[] }
  | { kind: "plan"; id: string; plan: string; planFilePath: string | null }
  /** The agent waits for input the overlay does not model (an MCP elicitation, a new dialog). */
  | { kind: "unknown"; id: string; message: string };

/** A choice the terminal shows in the dialog the agent waits on, read from the screen. */
export interface AgentDialogOption {
  number: number;
  label: string;
}

/**
 * The decision a permission dialog choice stands for, from its wording on screen ("Yes", "Yes, and
 * don't ask again for: python3 *", "Yes, and always allow access to <dir> from this project", "No");
 * null for a choice the overlay does not model ("Yes, and switch to auto mode").
 */
export function permissionDecisionOf(label: string): "allow" | "always" | "deny" | null {
  if (/^Yes$/u.test(label)) return "allow";
  if (/^Yes, and (?:don.t ask again|always allow)/iu.test(label)) return "always";
  if (/^No\b/u.test(label)) return "deny";
  return null;
}

/** What every window knows about each agent session, for tabs and the overlay header. */
export interface AgentSessionSummary {
  terminalId: string;
  agent: "claude";
  sessionId: string;
  state: AgentState;
  permissionMode: AgentPermissionMode | null;
  model: string | null;
  effort: string | null;
  title: string | null;
  cwd: string;
  /** The user's home directory, to show paths under it as `~/…`. */
  homeDir: string;
  interaction: AgentInteraction | null;
  /**
   * The dialog's choices as the terminal shows them, once the server has seen the dialog on screen;
   * null when it has not (yet), or when the screen shows something it does not recognize.
   */
  dialogOptions: AgentDialogOption[] | null;
  /** Set when a stop failed (a usage limit, an API error), with the agent's message. */
  error: string | null;
  updatedAt: number;
}

export interface AgentToolResult {
  text: string;
  isError: boolean;
}

/** One entry of the transcript, keyed by `id`; a later item with the same `id` replaces it. */
export type AgentTranscriptItem =
  | { kind: "user"; id: string; text: string; timestamp: string | null }
  | { kind: "command"; id: string; name: string; args: string; output: string | null }
  | { kind: "assistant"; id: string; text: string; timestamp: string | null }
  | { kind: "thinking"; id: string; text: string }
  | {
      kind: "tool";
      /** The tool use ID. */
      id: string;
      name: string;
      input: AgentJson;
      result: AgentToolResult | null;
    }
  | { kind: "system"; id: string; text: string };

/** A command, skill or agent the session can run, from the agent itself. */
export interface AgentCommand {
  name: string;
  description: string;
  argumentHint: string;
}

export interface AgentModelChoice {
  value: string;
  displayName: string;
  description: string;
  efforts: string[];
}

export interface AgentCatalog {
  commands: AgentCommand[];
  models: AgentModelChoice[];
  version: string | null;
}

/** What the renderer can ask the overlay to do in the terminal. */
export const AgentActionSchema = z.discriminatedUnion("type", [
  /** Send a prompt: submitted at once when idle, queued by the agent while it works. */
  z.object({ type: z.literal("prompt"), text: z.string().min(1).max(100_000) }),
  z.object({ type: z.literal("interrupt") }),
  z.object({
    type: z.literal("permission"),
    /** The interaction the user answered: the answer is refused if another one replaced it. */
    interactionId: z.string(),
    decision: z.enum(["allow", "always", "deny"]),
    /** With `deny`: what to tell the agent instead. */
    feedback: z.string().max(20_000).optional(),
  }),
  z.object({
    type: z.literal("question"),
    interactionId: z.string(),
    /** Per question, in order: the chosen labels, or free text instead of them. */
    answers: z
      .array(z.object({ labels: z.array(z.string()), other: z.string().max(20_000).optional() }))
      .min(1),
  }),
  z.object({
    type: z.literal("plan"),
    interactionId: z.string(),
    decision: z.enum(["approve-auto", "approve-manual", "revise"]),
    feedback: z.string().max(20_000).optional(),
  }),
  z.object({ type: z.literal("mode"), mode: AgentPermissionModeSchema }),
  // Typed after `/model ` or `/effort `: one word, never a second line.
  z.object({ type: z.literal("model"), model: z.string().regex(/^[\w.:[\]-]{1,100}$/u) }),
  z.object({ type: z.literal("effort"), effort: z.string().regex(/^\w{1,30}$/u) }),
]);
export type AgentAction = z.infer<typeof AgentActionSchema>;

export const AgentActionRequestSchema = z.object({
  terminalId: z.string().length(36),
  action: AgentActionSchema,
});
export type AgentActionRequest = z.infer<typeof AgentActionRequestSchema>;

/** The answer to an action: `fallback` when the user has to finish it in the terminal. */
export type AgentActionResult = { ok: true } | { ok: false; error: string; fallback: boolean };

/** Server-to-client messages of the overlay. */
export type AgentOverlayServerMessage =
  | { type: "agent_sessions_sync"; sessions: AgentSessionSummary[] }
  | { type: "agent_session"; terminalId: string; session: AgentSessionSummary | null }
  /** To subscribers: `reset` replaces the transcript, otherwise `items` are upserted by `id`. */
  | { type: "agent_transcript"; terminalId: string; reset: boolean; items: AgentTranscriptItem[] };

/** Client-to-server messages of the overlay. */
export type AgentOverlayClientMessage =
  | { type: "agent_subscribe"; terminalId: string }
  | { type: "agent_unsubscribe"; terminalId: string };
