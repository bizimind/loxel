import { z } from "zod";

/**
 * Schema for the global state file tracking all known wt-managed repositories.
 */
export const GlobalStateSchema = z.object({ version: z.literal(1), repos: z.array(z.string()) });

export type GlobalState = z.infer<typeof GlobalStateSchema>;
