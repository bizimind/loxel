/**
 * Terminals a coding agent starts with `loxel terminal`: the "When an Agent Starts a Terminal"
 * setting (Settings > Terminal), where such a terminal came from, and the requests waiting for the
 * user's answer. Shared by the CLI, the server and the renderer. See docs/TERMINALS.md#agent-terminals.
 */
import { z } from "zod";

/** Start the terminal at once, ask the user first, or refuse. */
export const AgentTerminalPolicySchema = z.enum(["run", "ask", "never"]);
export type AgentTerminalPolicy = z.infer<typeof AgentTerminalPolicySchema>;

/** Run, so agents keep starting terminals as they did before the setting. */
export const DEFAULT_AGENT_TERMINAL_POLICY: AgentTerminalPolicy = "run";

export const AGENT_TERMINAL_POLICY_LABELS: Record<AgentTerminalPolicy, string> = {
  run: "Run",
  ask: "Ask",
  never: "Never",
};

/** The setting in `value`, or the default for one that is missing or unknown (a newer version's). */
export function parseAgentTerminalPolicy(value: unknown): AgentTerminalPolicy {
  const parsed = AgentTerminalPolicySchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_AGENT_TERMINAL_POLICY;
}

/**
 * Who asked for a terminal, sent by the `loxel` CLI when a coding agent runs it: the agent's name
 * when the CLI recognizes it, and, from a Loxel terminal, that terminal and its worktree. Kept in
 * the new terminal's panel params, for its tab's tooltip.
 */
export const AgentOriginSchema = z.object({
  /** "Claude Code", "Codex", ...; absent for an agent the CLI does not recognize. */
  agent: z.string().max(100).optional(),
  /** The `terminalId` of the Loxel terminal the agent runs in (`LOXEL_TERMINAL_ID`). */
  terminalId: z.string().max(100).optional(),
  /** That terminal's worktree (`LOXEL_WORKTREE`); absent for a Home terminal. */
  worktreePath: z.string().optional(),
});
export type AgentOrigin = z.infer<typeof AgentOriginSchema>;

/** The agent's name, or "an agent" for one the CLI does not recognize. */
export function agentName(origin: AgentOrigin): string {
  return origin.agent ?? "an agent";
}

/** A terminal an agent asked for, waiting for the user to answer in a window. */
export interface AgentTerminalAsk {
  id: string;
  askedAt: number;
  /** The window that asks; absent while no window is connected. */
  windowId?: string;
  origin: AgentOrigin;
  /** Directory the shell starts in. */
  cwd: string;
  /** The terminal's worktree, or null for Home. */
  worktreePath: string | null;
  /** The command typed into the new shell. */
  command?: string;
  title?: string;
}

/** What every window mirrors: the requests waiting for an answer, and the worktrees that always run. */
export interface AgentTerminalsState {
  asks: AgentTerminalAsk[];
  /** Worktrees where the user chose "Always in this worktree": their agents' terminals run. */
  alwaysWorktrees: string[];
}

export const EMPTY_AGENT_TERMINALS_STATE: AgentTerminalsState = { asks: [], alwaysWorktrees: [] };

/** Run the terminal, run it and stop asking for its worktree, or decline. */
export const AgentTerminalAnswerSchema = z.enum(["run", "always", "decline"]);
export type AgentTerminalAnswer = z.infer<typeof AgentTerminalAnswerSchema>;
