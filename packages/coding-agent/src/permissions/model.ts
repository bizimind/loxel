import { z } from "zod";

export const approvalDecisionSchema = z.enum([
  "allow",
  "allow_this_session",
  "allow_always",
  "deny",
]);

export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

export const permissionRuleSchema = z
  .object({ id: z.string(), tool: z.string(), fingerprint: z.string(), createdAt: z.string() })
  .strict();

export type PermissionRule = z.infer<typeof permissionRuleSchema>;

export const permissionFileSchema = z
  .object({ version: z.literal(1), updatedAt: z.string(), rules: z.array(permissionRuleSchema) })
  .strict();

export type PermissionFile = z.infer<typeof permissionFileSchema>;
