/**
 * Messages that carry browser panel pages' camera and microphone permission (`getUserMedia()`)
 * between the Electron main process, which decides it (see `browser-media.ts`), the window
 * renderer that asks the user, and the webview preload that reports it to
 * `navigator.permissions.query()`.
 */
import { z } from "zod";

/** A capture device a page can ask for, named as the Permissions API names it. */
export const mediaDeviceSchema = z.enum(["camera", "microphone"]);
export type MediaDevice = z.infer<typeof mediaDeviceSchema>;
export const MEDIA_DEVICES = mediaDeviceSchema.options;

/** What the user decided for a site's use of a device. */
export const mediaDecisionSchema = z.enum(["allow", "block"]);
export type MediaDecision = z.infer<typeof mediaDecisionSchema>;

/** A site's decisions, per device; a device not listed asks. */
export type MediaSiteDecisions = Partial<Record<MediaDevice, MediaDecision>>;

/** Decisions by origin (`https://meet.google.com`), kept in Loxel's settings. */
export type MediaSites = Record<string, MediaSiteDecisions>;

/** The valid entries of stored or sent decisions; anything else (hand-edited) is dropped. */
export function parseMediaSites(value: unknown): MediaSites {
  if (typeof value !== "object" || value === null) return {};
  const sites: MediaSites = {};
  for (const [origin, decisions] of Object.entries(value)) {
    if (typeof decisions !== "object" || decisions === null) continue;
    const valid: MediaSiteDecisions = {};
    for (const device of MEDIA_DEVICES) {
      const parsed = mediaDecisionSchema.safeParse(Reflect.get(decisions, device));
      if (parsed.success) valid[device] = parsed.data;
    }
    if (Object.keys(valid).length > 0) sites[origin] = valid;
  }
  return sites;
}

/** `sites` with `decision` for each of `devices` of `origin`, or those forgotten (`null`). */
export function withMediaDecision(
  sites: MediaSites,
  origin: string,
  devices: readonly MediaDevice[],
  decision: MediaDecision | null,
): MediaSites {
  const { [origin]: previous, ...others } = sites;
  const decisions: MediaSiteDecisions = { ...previous };
  for (const device of devices) {
    if (decision) decisions[device] = decision;
    else delete decisions[device];
  }
  return Object.keys(decisions).length > 0 ? { ...others, [origin]: decisions } : others;
}

/** `PermissionStatus.state` for each device, as the page sees it. */
export type MediaPermissionStates = Record<MediaDevice, "granted" | "denied" | "prompt">;

/** Main → window renderer: ask the user whether `origin` may use `devices`. */
export const mediaPermissionRequestSchema = z.object({
  id: z.number().int(),
  webContentsId: z.number().int(),
  origin: z.string(),
  /** Grows when the page asks for another device while the prompt is up; the id stays. */
  devices: z.array(mediaDeviceSchema).min(1),
});
export type MediaPermissionRequest = z.infer<typeof mediaPermissionRequestSchema>;

/**
 * The user's answer: `allow` and `block` are saved for the site, `allow-once` lasts while the
 * panel stays on the site, and `dismiss` refuses this request only, so the page may ask again.
 */
export const mediaPermissionAnswerSchema = z.enum(["allow", "allow-once", "block", "dismiss"]);
export type MediaPermissionAnswer = z.infer<typeof mediaPermissionAnswerSchema>;

/** Window renderer → main: the user's answer to a request. */
export const mediaPermissionResponseSchema = z.object({
  id: z.number().int(),
  answer: mediaPermissionAnswerSchema,
});
export type MediaPermissionResponse = z.infer<typeof mediaPermissionResponseSchema>;

/** Main → window renderer: a request was withdrawn (decided elsewhere, or the page went away). */
export const mediaPermissionWithdrawnSchema = z.object({
  id: z.number().int(),
  webContentsId: z.number().int(),
});

/**
 * Main → window renderer: the site was allowed, but macOS has Loxel's access to `devices` turned
 * off (System Settings > Privacy & Security), so the page was refused.
 */
export const mediaSystemBlockedSchema = z.object({
  webContentsId: z.number().int(),
  /** The site that was refused, so the notice goes once the panel leaves it. */
  origin: z.string(),
  devices: z.array(mediaDeviceSchema).min(1),
});
export type MediaSystemBlocked = z.infer<typeof mediaSystemBlockedSchema>;
