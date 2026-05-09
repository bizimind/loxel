import { z } from "zod";

/** Content fingerprint for anchoring comments to code that may shift */
export const ContentAnchorSchema = z.object({
  /** The commented line(s) */
  content: z.array(z.string()),
  /** Up to 3 lines before the commented range */
  contextBefore: z.array(z.string()),
  /** Up to 3 lines after the commented range */
  contextAfter: z.array(z.string()),
  /** FNV-1a hash of content.join("\n") for quick comparison */
  contentHash: z.string(),
});

export type ContentAnchor = z.infer<typeof ContentAnchorSchema>;
