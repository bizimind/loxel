/**
 * Wire protocol between the server and the LaunchServices helper process: one JSON object
 * per line over the helper's stdin (requests) and stdout (responses).
 */
import { z } from "zod";

/** Argument that makes the server executable run as the LaunchServices helper instead. */
export const LAUNCH_SERVICES_HELPER_FLAG = "--launch-services-helper";

export const HelperRequestSchema = z.discriminatedUnion("op", [
  z.object({ id: z.number(), op: z.literal("apps"), path: z.string() }),
  z.object({ id: z.number(), op: z.literal("icon"), appPath: z.string() }),
]);
export type HelperRequest = z.infer<typeof HelperRequestSchema>;
export type HelperOp = HelperRequest["op"];

export const HelperResponseSchema = z.discriminatedUnion("ok", [
  z.object({ id: z.number(), ok: z.literal(true), result: z.unknown() }),
  z.object({ id: z.number(), ok: z.literal(false), error: z.string() }),
]);
export type HelperResponse = z.infer<typeof HelperResponseSchema>;

/** Result of the `apps` op: absolute `.app` bundle paths, as reported by macOS. */
export const RawAppListSchema = z.object({
  defaultApp: z.string().nullable(),
  apps: z.array(z.string()),
});
export type RawAppList = z.infer<typeof RawAppListSchema>;

/** Result of the `icon` op: base64-encoded PNG. */
export const IconResultSchema = z.string();
