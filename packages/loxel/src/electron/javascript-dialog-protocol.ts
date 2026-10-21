/**
 * Messages that carry a browser panel page's `alert()` / `confirm()` / `prompt()` from the
 * webview's preload, through the main process, to the window renderer that shows the dialog in
 * that panel (see `javascript-dialogs.ts`).
 */
import { z } from "zod";

export const javaScriptDialogTypeSchema = z.enum(["alert", "confirm", "prompt"]);
export type JavaScriptDialogType = z.infer<typeof javaScriptDialogTypeSchema>;

/** Webview preload → main (synchronous): the page called a dialog function. */
export const pageDialogCallSchema = z.object({
  type: javaScriptDialogTypeSchema,
  message: z.string(),
  defaultValue: z.string(),
});

/** Main → window renderer: show a dialog in the browser panel hosting `webContentsId`. */
export const javaScriptDialogRequestSchema = pageDialogCallSchema.extend({
  id: z.number().int(),
  /** The guest webContents of the panel's `<webview>`. */
  webContentsId: z.number().int(),
  /** Who is asking, like a browser's "localhost:5173 says". */
  title: z.string(),
  /** Offer to block further dialogs: this page already showed one. */
  canSuppress: z.boolean(),
});
export type JavaScriptDialogRequest = z.infer<typeof javaScriptDialogRequestSchema>;

/** Window renderer → main: how the user closed the dialog. */
export const javaScriptDialogResponseSchema = z.object({
  id: z.number().int(),
  /** OK (true) or Cancel / Escape (false). */
  accepted: z.boolean(),
  /** The prompt's text; ignored for alert and confirm. */
  value: z.string(),
  /** Block further dialogs from this page until it navigates. */
  suppress: z.boolean(),
});
export type JavaScriptDialogResponse = z.infer<typeof javaScriptDialogResponseSchema>;

/** Main → window renderer: a dialog was withdrawn (the page navigated or went away). */
export const javaScriptDialogClosedSchema = z.object({
  id: z.number().int(),
  webContentsId: z.number().int(),
});
export type JavaScriptDialogClosed = z.infer<typeof javaScriptDialogClosedSchema>;
