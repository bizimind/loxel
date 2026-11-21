/**
 * What the deduper may do with a model result. The model's output is a suggestion: these checks
 * decide which relations are acted on and how model text appears in a public comment.
 */

import type { DedupeResult, Relation } from "./schema.ts";

/** At most this many relations per issue are acted on. */
export const MAX_RELATIONS = 5;
export const MAX_REASONING_LENGTH = 120;
export const MAX_UNIQUE_VALUE_LENGTH = 300;

/**
 * The relations to act on: those pointing at a stored issue other than the target, and for
 * "duplicate" and "subset" (which close the target) at an older one, without repeats, at most
 * MAX_RELATIONS. Throws when the result is for another issue.
 */
export function checkRelations(
  result: DedupeResult,
  target: number,
  knownIssues: ReadonlySet<number>,
): Relation[] {
  if (result.issue_number !== target) {
    throw new Error(`Result is for issue #${result.issue_number}, expected #${target}`);
  }
  const seen = new Set<number>();
  return result.relations
    .filter((relation) => {
      const related = relation.related_issue;
      const closes = relation.relationship === "duplicate" || relation.relationship === "subset";
      if (related === target || !knownIssues.has(related) || seen.has(related)) return false;
      if (closes && related > target) return false;
      seen.add(related);
      return true;
    })
    .slice(0, MAX_RELATIONS);
}

/**
 * Model text as one short line inside an inline code span, which keeps GitHub from rendering
 * markdown, links, @mentions or #references in it. Null when there is no text.
 */
export function commentText(text: string | undefined, maxLength: number): string | null {
  const plain = (text ?? "")
    .replace(/[`\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return null;
  const clipped = plain.length > maxLength ? `${plain.slice(0, maxLength - 1).trimEnd()}…` : plain;
  return `\`${clipped}\``;
}

/** What the deduper checks about a related issue before closing another in its favor. */
export interface IssueRecord {
  state: string;
  isPullRequest: boolean;
  /** The issue author's permission on the repository, as the collaborator permission API reports it. */
  authorPermission: string;
}

/**
 * Whether a high-confidence "duplicate" or "subset" may close the target in favor of `related`:
 * an open issue (not a pull request) filed by someone with write access. Otherwise the deduper only
 * comments and leaves closing to a maintainer.
 */
export function mayCloseInFavorOf(related: IssueRecord): boolean {
  return (
    !related.isPullRequest &&
    related.state === "open" &&
    (related.authorPermission === "admin" || related.authorPermission === "write")
  );
}
