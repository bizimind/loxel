/**
 * What quitting Loxel does to the terminals: the "When quitting Loxel" setting (Settings >
 * Terminal), and the confirmation a quit shows first when terminals are running programs. Shared by
 * the renderer and Electron main, whose build has no path aliases, so the imports are relative.
 */
import { z } from "zod";

import type { RunningTerminal } from "../api/running-terminals-model";
import {
  BusyTerminalSchema,
  busyTerminals,
  terminalCount,
  unknownTerminalCount,
} from "./busy-terminals";

/**
 * What Quit Loxel (⌘Q), and every other quit that does not say itself (the Dock, logout), does to
 * the terminals: ask first when any is running a program, keep them running, or end them.
 */
export const WhenQuittingSchema = z.enum(["ask", "keep", "end"]);
export type WhenQuitting = z.infer<typeof WhenQuittingSchema>;

export const DEFAULT_WHEN_QUITTING: WhenQuitting = "ask";

export const WHEN_QUITTING_LABELS: Record<WhenQuitting, string> = {
  ask: "Ask when terminals are running",
  keep: "Keep terminals running",
  end: "End terminals",
};

/** The setting in `value`, or the default for one that is missing or unknown (a newer version's). */
export function parseWhenQuitting(value: unknown): WhenQuitting {
  const parsed = WhenQuittingSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_WHEN_QUITTING;
}

export const QuitConfirmationSchema = z.object({
  title: z.string(),
  message: z.string(),
  /** The terminals with a program running, where their terminal host can tell. */
  busy: z.array(BusyTerminalSchema),
});
export type QuitConfirmation = z.infer<typeof QuitConfirmationSchema>;

/** Main asks a window's renderer to show `confirmation`; `id` ties the answer to the question. */
export const QuitQuestionSchema = z.object({
  id: z.number(),
  confirmation: QuitConfirmationSchema,
});
export type QuitQuestion = z.infer<typeof QuitQuestionSchema>;

/** Quit ending the terminals, quit keeping them running, or stay open. */
export const QuitAnswerSchema = z.enum(["end", "keep", "cancel"]);
export type QuitAnswer = z.infer<typeof QuitAnswerSchema>;

export const QuitReplySchema = z.object({ id: z.number(), answer: QuitAnswerSchema });
export type QuitReply = z.infer<typeof QuitReplySchema>;

/** The answers' button labels, in the native dialog's and the window's. */
export const QUIT_ANSWER_LABELS: Record<QuitAnswer, string> = {
  end: "Quit and End Terminals",
  keep: "Quit and Keep Terminals",
  cancel: "Cancel",
};

/**
 * What to ask before a quit that would end the terminals `running`, or null when none is running a
 * program and the quit goes ahead at once. A terminal whose terminal host cannot tell its program
 * (one without capability `foregroundProcess`) is counted, since it may be. `null` means the
 * terminals could not be listed (the server did not answer in time): the question is asked without
 * a list, since quitting may end programs.
 */
export function quitConfirmation(
  running: readonly RunningTerminal[] | null,
): QuitConfirmation | null {
  if (running === null) {
    return {
      title: "Terminals may be running programs",
      message:
        "Loxel could not list its terminals. Quitting ends them, unless you keep them running until Loxel opens again.",
      busy: [],
    };
  }
  const busy = busyTerminals(running);
  const unknown = unknownTerminalCount(running);
  if (busy.length === 0 && unknown === 0) return null;

  const them = busy.length + unknown === 1 ? "it" : "them";
  const consequence = `Quitting ends ${them}, unless you keep ${them} running until Loxel opens again.`;
  if (busy.length === 0) {
    return {
      title:
        unknown === 1
          ? "A terminal may be running a program"
          : `${unknown} terminals may be running programs`,
      message: consequence,
      busy,
    };
  }
  const others =
    unknown === 0
      ? ""
      : ` Loxel cannot tell whether ${unknown === 1 ? "1 other terminal is" : `${unknown} other terminals are`} running one.`;
  return {
    title:
      busy.length === 1
        ? "A program is running in a terminal"
        : `Programs are running in ${terminalCount(busy.length)}`,
    message: `${consequence}${others}`,
    busy,
  };
}
