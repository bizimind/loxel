import type { ValidationIssue } from "@bizimind/localdb-sdk";

export function issueMessage(issues?: ValidationIssue[]): string | undefined {
  return issues && issues.length > 0 ? issues[0]?.message : undefined;
}

/** Group validation issues by their first path segment; pathless issues go under "_". */
export function groupIssuesByColumn(issues: ValidationIssue[]): Record<string, ValidationIssue[]> {
  const grouped: Record<string, ValidationIssue[]> = {};
  for (const issue of issues) {
    const key = issue.path[0] ?? "_";
    (grouped[key] ??= []).push(issue);
  }
  return grouped;
}
