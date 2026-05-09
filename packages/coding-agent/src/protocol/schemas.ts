import { z } from "zod";

import { SESSION_ID_PATTERN } from "../core/id-format.ts";
import { approvalDecisionSchema } from "../permissions/model.ts";

const sessionIdSchema = z
  .string()
  .regex(SESSION_ID_PATTERN, "session_id must match [a-zA-Z0-9_-] and be <= 128 chars");

export const messageEnvelopeSchema = z
  .object({
    id: z.string().optional(),
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.unknown(),
  })
  .strict();

const sessionStartSchema = z
  .object({
    type: z.literal("session.start"),
    request_id: z.string(),
    session_id: sessionIdSchema.optional(),
    workspace_root: z.string(),
    mode: z.enum(["execute", "plan"]).optional(),
    profile: z.enum(["execute", "plan", "minimal"]).optional(),
    prompt_profile: z.string().optional(),
    declared_tools: z.array(z.string()).optional(),
    messages: z.array(messageEnvelopeSchema).optional(),
  })
  .strict();

const sessionInputSchema = z
  .object({
    type: z.literal("session.input"),
    request_id: z.string(),
    session_id: sessionIdSchema,
    messages: z.array(messageEnvelopeSchema).min(1),
    model_profile: z.enum(["planner", "executor", "fallback"]).optional(),
    rewind_to_message_id: z.string().optional(),
    approval_overrides: z.record(z.string(), z.enum(["allow", "deny"])).optional(),
  })
  .strict();

const sessionCancelSchema = z
  .object({
    type: z.literal("session.cancel"),
    request_id: z.string(),
    session_id: sessionIdSchema,
    run_id: z.string().optional(),
  })
  .strict();

const sessionCloseSchema = z
  .object({ type: z.literal("session.close"), request_id: z.string(), session_id: sessionIdSchema })
  .strict();

const sessionResumeSchema = z
  .object({
    type: z.literal("session.resume"),
    request_id: z.string(),
    session_id: sessionIdSchema,
    rewind_to_message_id: z.string().optional(),
  })
  .strict();

const sessionCompactSchema = z
  .object({
    type: z.literal("session.compact"),
    request_id: z.string(),
    session_id: sessionIdSchema,
  })
  .strict();

const sessionForkSchema = z
  .object({
    type: z.literal("session.fork"),
    request_id: z.string(),
    session_id: sessionIdSchema,
    message_id: z.string().optional(),
  })
  .strict();

const sessionListSchema = z
  .object({ type: z.literal("session.list"), request_id: z.string() })
  .strict();

const sessionGetSchema = z
  .object({ type: z.literal("session.get"), request_id: z.string(), session_id: sessionIdSchema })
  .strict();

const humanInputResponseSchema = z
  .object({
    type: z.literal("human.input.response"),
    request_id: z.string(),
    session_id: sessionIdSchema,
    run_id: z.string(),
    pending_key: z.string().optional(),
    question_id: z.string().optional(),
    selected_options: z.array(z.string()).optional(),
    answers: z.record(z.string(), z.array(z.string())).optional(),
    freeform_text: z.string().optional(),
    freeform: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const approvalResponseSchema = z
  .object({
    type: z.literal("approval.response"),
    request_id: z.string(),
    session_id: sessionIdSchema,
    run_id: z.string(),
    pending_key: z.string().optional(),
    tool_name: z.string(),
    decision: approvalDecisionSchema,
  })
  .strict();

export const protocolRequestSchema = z.discriminatedUnion("type", [
  sessionStartSchema,
  sessionInputSchema,
  sessionCancelSchema,
  sessionCloseSchema,
  sessionResumeSchema,
  sessionCompactSchema,
  sessionForkSchema,
  sessionListSchema,
  sessionGetSchema,
  humanInputResponseSchema,
  approvalResponseSchema,
]);

export type ProtocolRequest = z.infer<typeof protocolRequestSchema>;

const baseEventSchema = z
  .object({
    type: z.string(),
    request_id: z.string().optional(),
    session_id: z.string(),
    run_id: z.string().optional(),
    timestamp: z.string(),
    payload: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const protocolEventSchema = baseEventSchema;

export type ProtocolEvent = z.infer<typeof protocolEventSchema>;
