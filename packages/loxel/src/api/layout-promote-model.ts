/**
 * The body of `POST /api/layout/promote`, which Electron main sends when windows close: the
 * windows whose session layouts become canonical, applied in order, so the last one wins.
 */
import { z } from "zod";

import { isWindowId } from "../lib/layout-key-schema";

export const PromoteLayoutBodySchema = z.object({
  windowIds: z.array(z.string().refine(isWindowId)).min(1),
});
export type PromoteLayoutBody = z.infer<typeof PromoteLayoutBodySchema>;
