/**
 * The private channel from the desktop app to the server it started: a pipe on the server's file
 * descriptor `PARENT_CHANNEL_FD`, one `ParentMessage` per line, open for the server's whole life.
 * The pipe closing without a `shutdown` means the app is gone. Electron main writes it,
 * `src/server/parent-channel.ts` reads it.
 *
 * Not stdin, which carries only the data encryption key and is closed after it: children the
 * server starts with `Bun.$`, or with Bun.spawn's `stdin: "inherit"`, get the server's stdin, so
 * an open one would reach every git command and hook. Bun passes no descriptor above 2 to a child.
 */
import { z } from "zod";

/** The server's descriptor for the channel: the first one after stdin, stdout and stderr. */
export const PARENT_CHANNEL_FD = 3;

/**
 * How long a launching app waits for a server that a previous run of it left shutting down. A
 * stopping server lets go of the port within it, or the launch fails.
 */
export const STOPPING_SERVER_WAIT_MS = 15_000;

/** What a shutdown the app asks for does to the terminals: `end` them, or `keep` them running. */
export const ShutdownTerminalsSchema = z.enum(["end", "keep"]);
export type ShutdownTerminals = z.infer<typeof ShutdownTerminalsSchema>;

export const ParentMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("shutdown"), terminals: ShutdownTerminalsSchema }),
]);
export type ParentMessage = z.infer<typeof ParentMessageSchema>;

export function encodeParentMessage(message: ParentMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/** The message a line carries, or null when it is not one. */
export function parseParentMessage(line: string): ParentMessage | null {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = ParentMessageSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}
