/**
 * Convenience helpers for building SessionEventHandlers.
 */
import type { SessionEvent, SessionEventHandlers } from "./session-types.ts";

/**
 * Build a full SessionEventHandlers from a partial set of handlers.
 * Unspecified informational events default to null (no-op).
 * approval.requested auto-responds with "allow".
 * human.input.requested auto-responds with empty answers.
 *
 * @example
 * ```ts
 * const session = await Session.create({
 *   workspaceRoot: "/project",
 *   handlers: withAutoApprove({
 *     "run.delta": (e) => process.stdout.write(e.text),
 *     "run.completed": (e) => console.log(e.text),
 *     "error": (e) => console.error(e.diagnostic),
 *   }),
 * });
 * ```
 */
export function withAutoApprove(partial: Partial<SessionEventHandlers>): SessionEventHandlers {
  return {
    "session.started": null,
    "session.resumed": null,
    "run.started": null,
    "run.delta": null,
    "run.reasoning": null,
    "run.completed": null,
    "run.failed": null,
    "run.cancelled": null,
    "tool.call.requested": null,
    "tool.call.result": null,
    "approval.requested": (e) => e.respond("allow"),
    "human.input.requested": (e) => e.respond({}),
    "message.received": null,
    "session.rewound": null,
    "plan.mode.entered": null,
    "plan.mode.exited": null,
    "plan.updated": null,
    "plan.step.changed": null,
    "plan.completed": null,
    "todo.updated": null,
    "session.got": null,
    error: null,
    ...partial,
  };
}

/** All session event types. Useful for iteration or validation. */
export const SESSION_EVENT_TYPES: readonly SessionEvent["type"][] = [
  "session.started",
  "session.resumed",
  "run.started",
  "run.delta",
  "run.reasoning",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "tool.call.requested",
  "tool.call.result",
  "approval.requested",
  "human.input.requested",
  "message.received",
  "session.rewound",
  "plan.mode.entered",
  "plan.mode.exited",
  "plan.updated",
  "plan.step.changed",
  "plan.completed",
  "todo.updated",
  "session.got",
  "error",
] as const;
