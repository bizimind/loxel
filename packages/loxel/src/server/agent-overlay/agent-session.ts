/**
 * One Claude Code session in one terminal, as its hooks and transcript describe it: the state the
 * tab shows, the interaction Claude waits on, and the transcript. Pure state: the service feeds it
 * hook payloads and transcript records and broadcasts what changed.
 */
import { homedir } from "node:os";

import { z } from "zod";

import type {
  AgentDialogOption,
  AgentInteraction,
  AgentJson,
  AgentPermissionMode,
  AgentQuestion,
  AgentSessionSummary,
  AgentState,
  AgentTranscriptItem,
} from "@/api/agent-overlay-model";
import { AgentPermissionModeSchema } from "@/api/agent-overlay-model";

import { TranscriptModel } from "./claude-transcript";

const JsonSchema: z.ZodType<AgentJson> = z.json();

/** The fields of a hook payload the overlay reads; everything else passes through unread. */
export const HookPayloadSchema = z
  .object({
    hook_event_name: z.string(),
    session_id: z.string(),
    transcript_path: z.string(),
    cwd: z.string(),
    permission_mode: z.string().optional(),
    model: z.unknown().optional(),
    effort: z.unknown().optional(),
    tool_name: z.string().optional(),
    tool_input: JsonSchema.optional(),
    tool_use_id: z.string().optional(),
    permission_suggestions: z.array(JsonSchema).optional(),
    notification_type: z.string().optional(),
    message: z.string().optional(),
    error: z.unknown().optional(),
    reason: z.string().optional(),
  })
  .passthrough();
export type HookPayload = z.infer<typeof HookPayloadSchema>;

const QuestionsSchema = z.array(
  z.object({
    question: z.string(),
    header: z.string().default(""),
    options: z
      .array(z.object({ label: z.string(), description: z.string().default("") }))
      .default([]),
    multiSelect: z.boolean().default(false),
  }),
);

function questionsOf(input: unknown): AgentQuestion[] | null {
  const questions = z.object({ questions: QuestionsSchema }).safeParse(input);
  return questions.success ? questions.data.questions : null;
}

function planOf(input: unknown): { plan: string; planFilePath: string | null } {
  const parsed = z
    .object({ plan: z.string().default(""), planFilePath: z.string().optional() })
    .safeParse(input);
  return parsed.success
    ? { plan: parsed.data.plan, planFilePath: parsed.data.planFilePath ?? null }
    : { plan: "", planFilePath: null };
}

function modelName(value: unknown): string | null {
  if (typeof value === "string") return value;
  const parsed = z.object({ id: z.string() }).safeParse(value);
  return parsed.success ? parsed.data.id : null;
}

function effortLevel(value: unknown): string | null {
  if (typeof value === "string") return value;
  const parsed = z.object({ level: z.string() }).safeParse(value);
  return parsed.success ? parsed.data.level : null;
}

function errorText(payload: HookPayload): string {
  if (typeof payload.error === "string") return payload.error;
  const nested = z.object({ message: z.string() }).safeParse(payload.error);
  if (nested.success) return nested.data.message;
  return payload.message ?? "Claude stopped with an error";
}

export interface SessionChange {
  summary: boolean;
  /** The transcript file changed (a new session in the same terminal, `/clear`). */
  transcriptPath: string | null;
}

export class AgentSession {
  private transcript = new TranscriptModel();
  sessionId: string;
  transcriptPath: string;
  private state: AgentState = "idle";
  private permissionMode: AgentSessionSummary["permissionMode"] = null;
  private model: string | null = null;
  private effort: string | null = null;
  private cwd: string;
  private interaction: AgentInteraction | null = null;
  private dialogOptions: AgentDialogOption[] | null = null;
  private error: string | null = null;
  private updatedAt = Date.now();
  private eventCount = 0;

  constructor(
    readonly terminalId: string,
    first: HookPayload,
  ) {
    this.sessionId = first.session_id;
    this.transcriptPath = first.transcript_path;
    this.cwd = first.cwd;
  }

  /** Applies a hook; reports whether the summary changed and whether to follow another file. */
  applyHook(payload: HookPayload): SessionChange {
    this.eventCount++;
    const change: SessionChange = { summary: true, transcriptPath: null };
    if (payload.session_id !== this.sessionId) {
      // Every process in the terminal inherits its hook variables, so a `claude -p` the agent or
      // a script runs reports here too. Only a new session the terminal starts (`/clear`, a
      // resume, a fresh `claude` after the last one ended) replaces this one.
      if (payload.hook_event_name !== "SessionStart" && this.state !== "ended") {
        return { summary: false, transcriptPath: null };
      }
    }
    if (payload.session_id !== this.sessionId || payload.transcript_path !== this.transcriptPath) {
      this.sessionId = payload.session_id;
      this.transcriptPath = payload.transcript_path;
      change.transcriptPath = payload.transcript_path;
    }
    this.cwd = payload.cwd;
    const mode = AgentPermissionModeSchema.safeParse(payload.permission_mode);
    if (mode.success) this.permissionMode = mode.data;
    this.model = modelName(payload.model) ?? this.model;
    this.effort = effortLevel(payload.effort) ?? this.effort;

    const tool = payload.tool_name;
    switch (payload.hook_event_name) {
      case "SessionStart":
        this.setState("idle");
        this.clearInteraction();
        break;
      case "UserPromptSubmit":
        this.setState("working");
        this.clearInteraction();
        this.error = null;
        break;
      case "PreToolUse": {
        this.setState("working");
        const id = payload.tool_use_id ?? `event-${this.eventCount}`;
        if (tool === "AskUserQuestion") {
          const questions = questionsOf(payload.tool_input);
          this.setInteraction(
            questions
              ? { kind: "question", id, questions }
              : { kind: "unknown", id, message: "Claude asks a question" },
          );
        } else if (tool === "ExitPlanMode") {
          this.setInteraction({ kind: "plan", id, ...planOf(payload.tool_input) });
        }
        break;
      }
      case "PermissionRequest": {
        this.setState("needs-input");
        // The question and the plan approval were announced by PreToolUse, with their tool use ID.
        if (tool === "AskUserQuestion" || tool === "ExitPlanMode") {
          if (this.interaction) break;
          const id = `event-${this.eventCount}`;
          this.setInteraction(
            tool === "ExitPlanMode"
              ? { kind: "plan", id, ...planOf(payload.tool_input) }
              : { kind: "question", id, questions: questionsOf(payload.tool_input) ?? [] },
          );
          break;
        }
        this.setInteraction({
          kind: "permission",
          id: `event-${this.eventCount}`,
          toolName: tool ?? "tool",
          toolInput: payload.tool_input ?? null,
          suggestions: payload.permission_suggestions ?? [],
        });
        break;
      }
      case "PostToolUse":
      case "PostToolUseFailure":
      case "PermissionDenied":
        this.setState("working");
        this.clearInteraction();
        break;
      case "Notification":
        if (
          payload.notification_type === "permission_prompt" ||
          payload.notification_type === "elicitation_dialog"
        ) {
          this.setState("needs-input");
          if (!this.interaction) {
            this.setInteraction({
              kind: "unknown",
              id: `event-${this.eventCount}`,
              message: payload.message ?? "Claude is waiting for input",
            });
          }
        } else {
          change.summary = false;
        }
        break;
      case "Stop":
        this.setState("idle");
        this.clearInteraction();
        break;
      case "StopFailure":
        this.setState("failed");
        this.clearInteraction();
        this.error = errorText(payload);
        break;
      case "SessionEnd":
        this.setState("ended");
        this.clearInteraction();
        break;
      default:
        change.summary = false;
    }
    this.updatedAt = Date.now();
    return change;
  }

  /** The mode the footer shows after the overlay switched it, which no hook reports. */
  setPermissionMode(mode: AgentPermissionMode): void {
    this.permissionMode = mode;
    this.updatedAt = Date.now();
  }

  /**
   * The overlay ended the turn (an interrupt, a refused tool), after which Claude waits at its
   * input box without a Stop hook.
   */
  markInterrupted(): void {
    this.state = "idle";
    this.clearInteraction();
    this.updatedAt = Date.now();
  }

  /** The dialog choices as the screen shows them; null clears them. */
  setDialogOptions(options: AgentDialogOption[] | null): boolean {
    if (JSON.stringify(options) === JSON.stringify(this.dialogOptions)) return false;
    this.dialogOptions = options;
    return true;
  }

  /**
   * The screen no longer shows a dialog the interaction needs (answered or dismissed in the
   * terminal, which sends no hook): forget it.
   */
  dismissInteraction(): boolean {
    if (!this.interaction) return false;
    this.clearInteraction();
    if (this.state === "needs-input") this.state = "working";
    this.updatedAt = Date.now();
    return true;
  }

  get pendingInteraction(): AgentInteraction | null {
    return this.interaction;
  }

  applyTranscript(records: readonly unknown[]): AgentTranscriptItem[] {
    return records.flatMap((value) => this.transcript.apply(value));
  }

  transcriptItems(): AgentTranscriptItem[] {
    return this.transcript.all();
  }

  /** Starts the transcript over (another file); true if it had items. */
  resetTranscript(): boolean {
    const had = this.transcript.all().length > 0;
    this.transcript = new TranscriptModel();
    return had;
  }

  summary(): AgentSessionSummary {
    return {
      terminalId: this.terminalId,
      agent: "claude",
      sessionId: this.sessionId,
      state: this.state,
      permissionMode: this.permissionMode ?? this.transcript.permissionMode,
      model: this.model,
      effort: this.effort,
      title: this.transcript.title,
      cwd: this.cwd,
      homeDir: homedir(),
      interaction: this.interaction,
      dialogOptions: this.interaction ? this.dialogOptions : null,
      error: this.error,
      updatedAt: this.updatedAt,
    };
  }

  private setState(state: AgentState): void {
    this.state = state;
  }

  private setInteraction(interaction: AgentInteraction): void {
    this.interaction = interaction;
    this.dialogOptions = null;
  }

  private clearInteraction(): void {
    this.interaction = null;
    this.dialogOptions = null;
  }
}
