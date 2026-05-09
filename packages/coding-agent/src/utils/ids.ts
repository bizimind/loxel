import { randomUUID } from "node:crypto";

function make(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export const createSessionId = (): string => make("session");
export const createRunId = (): string => make("run");
export const createMessageId = (): string => make("msg");
export const createEventId = (): string => make("evt");
export const createBranchId = (): string => make("branch");
export const createCompactionId = (): string => make("compact");
export const createTaskId = (): string => make("task");
export const createPlanFileName = (): string => `${randomUUID()}.md`;
