import { z } from "zod";

export const ContainerStateSchema = z.enum([
  "created",
  "running",
  "paused",
  "stopped",
  "dead",
  "unknown",
]);

export type ContainerState = z.infer<typeof ContainerStateSchema>;

export const ContainerInfoSchema = z.object({
  /** Container ID (UUID or short hash depending on provider) */
  id: z.string(),
  /** Container name */
  name: z.string(),
  /** Image reference */
  image: z.string(),
  /** Current container state */
  state: ContainerStateSchema,
  /** Internal container IP (`null` when none assigned, e.g. network: "none") */
  ip: z.string().nullable().optional(),
  /** Labels on the container */
  labels: z.record(z.string(), z.string()).default({}),
  /** ISO timestamp of creation */
  createdAt: z.string().optional(),
});

export type ContainerInfo = z.infer<typeof ContainerInfoSchema>;
