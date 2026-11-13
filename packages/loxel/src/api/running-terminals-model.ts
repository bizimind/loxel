/**
 * The terminals the server runs, as `GET /api/terminals` reports them: what the update warning, its
 * confirmation and the terminal tabs show about them. The server builds it and the client parses
 * it, so both use this schema.
 */
import { z } from "zod";

export const RunningTerminalSchema = z.object({
  id: z.string(),
  /** The worktree the terminal belongs to. */
  worktreePath: z.string(),
  /** The directory its shell started in. */
  cwd: z.string(),
  /**
   * It runs in a terminal host of another build than the server's: one another version of Loxel
   * started. A new shell (Restart Terminal) runs in the current one.
   */
  otherHostBuild: z.boolean(),
  /**
   * The program in its foreground, null when the shell is at its prompt. Present only when asked
   * for (`?programs`) and its terminal host can tell (capability `foregroundProcess`).
   */
  program: z.string().nullable().optional(),
});
export type RunningTerminal = z.infer<typeof RunningTerminalSchema>;

export const RunningTerminalsSchema = z.object({ terminals: z.array(RunningTerminalSchema) });
export type RunningTerminals = z.infer<typeof RunningTerminalsSchema>;
