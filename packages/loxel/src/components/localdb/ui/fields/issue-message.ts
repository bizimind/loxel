import type { ValidationIssue } from "@bizimind/localdb-sdk";

export function issueMessage(issues?: ValidationIssue[]): string | undefined {
  return issues && issues.length > 0 ? issues[0]?.message : undefined;
}
