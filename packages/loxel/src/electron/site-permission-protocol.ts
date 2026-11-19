/**
 * Messages every browser panel permission prompt that offers Allow this time uses between the
 * Electron main process, which decides (see `permission-prompts.ts`), and the window renderer that
 * shows the prompt as a bar in the page's panel.
 */
import { z } from "zod";

/**
 * The user's answer: `allow` and `block` are saved for the site, `allow-once` covers less (what it
 * covers is the prompt's own), and `dismiss` refuses this request only.
 */
export const sitePermissionAnswerSchema = z.enum(["allow", "allow-once", "block", "dismiss"]);
export type SitePermissionAnswer = z.infer<typeof sitePermissionAnswerSchema>;

/** Window renderer → main: the user's answer to a request. */
export const sitePermissionResponseSchema = z.object({
  id: z.number().int(),
  answer: sitePermissionAnswerSchema,
});
export type SitePermissionResponse = z.infer<typeof sitePermissionResponseSchema>;

/** Main → window renderer: a request was withdrawn (decided elsewhere, or the page went away). */
export const permissionWithdrawnSchema = z.object({
  id: z.number().int(),
  webContentsId: z.number().int(),
});
