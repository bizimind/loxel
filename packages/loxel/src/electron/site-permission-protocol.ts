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

/** What the user decided for a site, saved in Loxel's settings. */
export const siteDecisionSchema = z.enum(["allow", "block"]);
export type SiteDecision = z.infer<typeof siteDecisionSchema>;

/**
 * Links to other apps (`mailto:`, `zoommtg:`) each site may open, by origin and then by the link's
 * scheme (`zoommtg`); a scheme not listed asks.
 */
export type ExternalAppSites = Record<string, Record<string, SiteDecision>>;

/** Whether each site (by origin) may reach this machine and the local network; others ask. */
export type LocalNetworkSites = Record<string, SiteDecision>;

/** The valid decisions of stored or sent settings; anything else (hand-edited) is dropped. */
function parseDecisions(value: unknown): Record<string, SiteDecision> {
  if (typeof value !== "object" || value === null) return {};
  const decisions: Record<string, SiteDecision> = {};
  for (const [key, decision] of Object.entries(value)) {
    const parsed = siteDecisionSchema.safeParse(decision);
    if (parsed.success) decisions[key] = parsed.data;
  }
  return decisions;
}

export function parseExternalAppSites(value: unknown): ExternalAppSites {
  if (typeof value !== "object" || value === null) return {};
  const sites: ExternalAppSites = {};
  for (const [origin, schemes] of Object.entries(value)) {
    const decisions = parseDecisions(schemes);
    if (Object.keys(decisions).length > 0) sites[origin] = decisions;
  }
  return sites;
}

export const parseLocalNetworkSites: (value: unknown) => LocalNetworkSites = parseDecisions;

/** `sites` with `decision` for `origin`'s links to `scheme`, or that forgotten (`null`). */
export function withExternalAppDecision(
  sites: ExternalAppSites,
  origin: string,
  scheme: string,
  decision: SiteDecision | null,
): ExternalAppSites {
  const { [origin]: previous, ...others } = sites;
  const { [scheme]: _previous, ...schemes } = previous ?? {};
  if (decision) schemes[scheme] = decision;
  return Object.keys(schemes).length > 0 ? { ...others, [origin]: schemes } : others;
}

/** Window renderer → main: the settings' decisions for both kinds of site access. */
export interface SiteAccessSites {
  externalApps: ExternalAppSites;
  localNetwork: LocalNetworkSites;
}

export function parseSiteAccessSites(value: unknown): SiteAccessSites {
  const fields = typeof value === "object" && value !== null ? value : {};
  return {
    externalApps: parseExternalAppSites(Reflect.get(fields, "externalApps")),
    localNetwork: parseLocalNetworkSites(Reflect.get(fields, "localNetwork")),
  };
}

/** What a site asks for: to open a link in another app, or to reach the local network. */
export const siteAccessSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("external-app"),
    origin: z.string(),
    /** The link's scheme, without the colon (`zoommtg`). */
    scheme: z.string(),
    /** The app that opens such links (`zoom.us`), or empty when the OS doesn't say. */
    app: z.string(),
  }),
  z.object({ kind: z.literal("local-network"), origin: z.string() }),
]);
export type SiteAccess = z.infer<typeof siteAccessSchema>;

/**
 * Main → window renderer: ask the user whether to let a site have `access`. Allow this time opens
 * this one link, or lets the page reach the local network while the panel stays on the site.
 */
export const siteAccessRequestSchema = z.object({
  id: z.number().int(),
  webContentsId: z.number().int(),
  access: siteAccessSchema,
});
export type SiteAccessRequest = z.infer<typeof siteAccessRequestSchema>;
