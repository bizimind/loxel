/**
 * Maps Claude Code's tool permission requests (`can_use_tool`, the SDK's `canUseTool`) to agent
 * interactions, and the user's answers back to permission results. AskUserQuestion and
 * ExitPlanMode arrive through the same request, so they become question and plan interactions.
 * The wire shapes are declared here rather than imported, so the mapping works for any transport
 * that speaks Claude Code's control protocol.
 */
import {
  isPermissionDestination,
  type AgentInteraction,
  type AgentQuestion,
  type InteractionResponse,
  type PermissionDestination,
  type PermissionSuggestion,
} from "@/api/agent-session-model";

/** A permission update as Claude Code sends and accepts it. */
export type ClaudePermissionUpdate =
  | {
      type: "addRules" | "replaceRules" | "removeRules";
      rules: { toolName: string; ruleContent?: string }[];
      behavior: "allow" | "deny" | "ask";
      destination: string;
    }
  | { type: "setMode"; mode: string; destination: string }
  | { type: "addDirectories" | "removeDirectories"; directories: string[]; destination: string };

export type ClaudePermissionResult =
  | {
      behavior: "allow";
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: ClaudePermissionUpdate[];
    }
  | { behavior: "deny"; message: string; interrupt?: boolean };

/** What Claude Code tells the host about a tool it wants to run. */
export interface ClaudeToolRequest {
  toolName: string;
  input: Record<string, unknown>;
  suggestions?: readonly ClaudePermissionUpdate[];
  title?: string;
  description?: string;
  decisionReason?: string;
  blockedPath?: string;
  suppressAlwaysAllowRule?: boolean;
}

export interface MappedToolRequest {
  interaction: AgentInteraction;
  /** The permission result for the user's answer. */
  resolve: (response: InteractionResponse) => ClaudePermissionResult;
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function parseQuestions(input: Json): AgentQuestion[] {
  const questions = Array.isArray(input.questions) ? input.questions.filter(isRecord) : [];
  return questions.flatMap((q) => {
    const question = str(q.question);
    if (!question) return [];
    const options = (Array.isArray(q.options) ? q.options.filter(isRecord) : []).map((o) => ({
      label: str(o.label) ?? "",
      description: str(o.description) ?? "",
      ...(str(o.preview) ? { preview: str(o.preview) } : {}),
    }));
    return [
      { question, header: str(q.header) ?? "", multiSelect: q.multiSelect === true, options },
    ];
  });
}

function ruleLabel(rule: { toolName: string; ruleContent?: string }): string {
  return rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName;
}

/** A human description of what a suggested permission update allows. */
export function describeSuggestion(update: ClaudePermissionUpdate): string {
  switch (update.type) {
    case "addRules":
    case "replaceRules":
      return update.rules.map(ruleLabel).join(", ");
    case "removeRules":
      return `Remove ${update.rules.map(ruleLabel).join(", ")}`;
    case "setMode":
      return `Switch to ${update.mode} mode`;
    case "addDirectories":
      return `Access to ${update.directories.join(", ")}`;
    case "removeDirectories":
      return `Remove access to ${update.directories.join(", ")}`;
    default: {
      const unknown: never = update;
      return unknown;
    }
  }
}

function withDestination(
  update: ClaudePermissionUpdate,
  destination: PermissionDestination | undefined,
): ClaudePermissionUpdate {
  if (!destination || update.type === "setMode") return update;
  return { ...update, destination };
}

export function mapToolRequest(id: string, request: ClaudeToolRequest): MappedToolRequest {
  const { toolName, input } = request;

  if (toolName === "AskUserQuestion") {
    return {
      interaction: { kind: "question", id, questions: parseQuestions(input) },
      resolve: (response) => {
        if (response.kind !== "question" || "dismissed" in response) {
          return {
            behavior: "deny",
            message: "The user dismissed the question without answering.",
          };
        }
        return { behavior: "allow", updatedInput: { ...input, answers: response.answers } };
      },
    };
  }

  if (toolName === "ExitPlanMode") {
    return {
      interaction: {
        kind: "plan",
        id,
        plan: str(input.plan) ?? "",
        ...(str(input.planFilePath) ? { planFilePath: str(input.planFilePath) } : {}),
      },
      resolve: (response) => {
        if (response.kind !== "plan") return { behavior: "deny", message: "Keep planning." };
        if (response.decision === "keep_planning") {
          const feedback = response.feedback.trim();
          return {
            behavior: "deny",
            message: feedback ? `Keep planning. Feedback: ${feedback}` : "Keep planning.",
          };
        }
        // Approving leaves plan mode; the chosen mode applies for the rest of the session, as in
        // the TUI's "approve and auto-accept edits" / "approve and review each edit".
        return {
          behavior: "allow",
          updatedInput: input,
          updatedPermissions: [{ type: "setMode", mode: response.mode, destination: "session" }],
        };
      },
    };
  }

  // Settings that forbid remembering this permission are enforced here, not only in the UI.
  const updates = request.suppressAlwaysAllowRule ? [] : (request.suggestions ?? []);
  const suggestions: PermissionSuggestion[] = updates.map((update, index) => ({
    id: String(index),
    label: describeSuggestion(update),
    destination: isPermissionDestination(update.destination) ? update.destination : "session",
    movable: update.type !== "setMode",
  }));

  return {
    interaction: {
      kind: "permission",
      id,
      toolName,
      ...(request.title ? { title: request.title } : {}),
      ...(request.description ? { description: request.description } : {}),
      ...(request.decisionReason ? { decisionReason: request.decisionReason } : {}),
      ...(request.blockedPath ? { blockedPath: request.blockedPath } : {}),
      input,
      suggestions,
      allowAlways: request.suppressAlwaysAllowRule !== true,
    },
    resolve: (response) => {
      if (response.kind !== "permission") {
        return { behavior: "deny", message: "The user denied this tool call." };
      }
      if (response.decision === "deny") {
        const message = response.message?.trim();
        return {
          behavior: "deny",
          message: message
            ? `The user denied this tool call: ${message}`
            : "The user denied this tool call.",
          ...(response.stop ? { interrupt: true } : {}),
        };
      }
      const chosen = (response.always ?? []).flatMap((choice) => {
        const update = updates[Number(choice.id)];
        return update ? [withDestination(update, choice.destination)] : [];
      });
      return {
        behavior: "allow",
        updatedInput: input,
        ...(chosen.length > 0 ? { updatedPermissions: chosen } : {}),
      };
    },
  };
}
