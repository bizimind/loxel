import { z } from "zod";

/** Folder apps are grouped in the menu: terminals, then editors. */
export const OpenInAppGroupSchema = z.enum(["terminal", "editor"]);
export type OpenInAppGroup = z.infer<typeof OpenInAppGroupSchema>;

/** An application that can open a file or folder, as listed in the "Open In" menu. */
export const OpenInAppSchema = z.object({
  /** Absolute path of the `.app` bundle. */
  path: z.string(),
  name: z.string(),
  /** Set for folder apps only. */
  group: OpenInAppGroupSchema.optional(),
});
export type OpenInApp = z.infer<typeof OpenInAppSchema>;

/**
 * Apps for a file: the system default, plus the others sorted by name (default excluded).
 * For a folder: no default, and the installed curated folder apps in menu order.
 */
export const OpenInAppsSchema = z.object({
  defaultApp: OpenInAppSchema.nullable(),
  apps: z.array(OpenInAppSchema),
});
export type OpenInApps = z.infer<typeof OpenInAppsSchema>;

export const RevealInFinderRequestSchema = z.object({ path: z.string() });
export type RevealInFinderRequest = z.infer<typeof RevealInFinderRequestSchema>;

export const OpenWithAppRequestSchema = RevealInFinderRequestSchema.extend({ appPath: z.string() });
export type OpenWithAppRequest = z.infer<typeof OpenWithAppRequestSchema>;
