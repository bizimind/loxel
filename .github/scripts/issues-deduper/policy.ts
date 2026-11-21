/**
 * What the deduper is allowed to do with a model result. The model's output is a suggestion: this
 * module decides which relations are acted on and what text from them reaches a public comment.
 */

import {
  type DedupeResult,
  MAX_REASONING_LENGTH,
  MAX_RELATIONS,
  MAX_UNIQUE_VALUE_LENGTH,
  type Relation,
} from "./schema.ts";

/** Author associations whose issues the deduper may close others as duplicates of. */
const PROJECT_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export interface RejectedRelation {
  relation: Relation;
  reason: string;
}

export interface CheckedRelations {
  accepted: Relation[];
  rejected: RejectedRelation[];
}

/**
 * Keep the relations that point at a known issue other than the target, and for "duplicate" and
 * "subset" (which close the target) at an older one. Repeats of the same related issue and anything
 * past MAX_RELATIONS are dropped.
 */
export function checkRelations(
  result: DedupeResult,
  target: number,
  knownIssues: ReadonlySet<number>,
): CheckedRelations {
  if (result.issue_number !== target) {
    throw new Error(`Result is for issue #${result.issue_number}, expected #${target}`);
  }

  const accepted: Relation[] = [];
  const rejected: RejectedRelation[] = [];
  const seen = new Set<number>();

  for (const relation of result.relations) {
    const reason = rejectionReason(relation, target, knownIssues, seen, accepted.length);
    if (reason) {
      rejected.push({ relation, reason });
      continue;
    }
    seen.add(relation.related_issue);
    accepted.push(relation);
  }
  return { accepted, rejected };
}

function rejectionReason(
  relation: Relation,
  target: number,
  knownIssues: ReadonlySet<number>,
  seen: ReadonlySet<number>,
  acceptedCount: number,
): string | null {
  const related = relation.related_issue;
  if (related === target) return "points at the issue itself";
  if (!knownIssues.has(related)) return "not a known issue";
  if (seen.has(related)) return "repeats an earlier relation";
  if (
    (relation.relationship === "duplicate" || relation.relationship === "subset") &&
    related > target
  ) {
    return "closing needs an older issue";
  }
  if (acceptedCount >= MAX_RELATIONS) return `more than ${MAX_RELATIONS} relations`;
  return null;
}

/** Runs that look like a token, key or encoded blob rather than prose. */
const SECRET_LIKE = /[A-Za-z0-9+/=_-]{32,}|\b(?:gh[oprsu]|github_pat)_[A-Za-z0-9_]+/;
const URL = /\b[a-z][a-z0-9+.-]*:\/\/\S+|\bwww\.\S+/gi;

/**
 * Model text cut down to one plain line of at most `maxLength` characters, with links and backticks
 * removed. Returns null when nothing usable is left, or when the text looks like a token or encoded
 * data, so it is left out entirely.
 */
export function plainText(text: string | undefined, maxLength: number): string | null {
  if (!text || SECRET_LIKE.test(text)) return null;
  const plain = text
    .replace(URL, "(link removed)")
    .replace(/[`\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return null;
  return plain.length > maxLength ? `${plain.slice(0, maxLength - 1).trimEnd()}…` : plain;
}

/**
 * plainText() as an inline code span, which keeps GitHub from rendering markdown, links, @mentions
 * or #references in it.
 */
export function commentText(text: string | undefined, maxLength: number): string | null {
  const plain = plainText(text, maxLength);
  return plain === null ? null : `\`${plain}\``;
}

/**
 * The result with its free text passed through plainText(), so the stored result carries no more
 * than a comment could. Relations past MAX_RELATIONS are dropped.
 */
export function sanitizeResult(result: DedupeResult): DedupeResult {
  return {
    issue_number: result.issue_number,
    relations: result.relations.slice(0, MAX_RELATIONS).map((relation) => {
      const uniqueValue = plainText(relation.unique_value, MAX_UNIQUE_VALUE_LENGTH);
      return {
        related_issue: relation.related_issue,
        relationship: relation.relationship,
        confidence: relation.confidence,
        reasoning: plainText(relation.reasoning, MAX_REASONING_LENGTH) ?? "",
        ...(uniqueValue === null ? {} : { unique_value: uniqueValue }),
      };
    }),
  };
}

/** The parts of a related issue's GitHub record the deduper checks before acting on it. */
export interface IssueRecord {
  state: string;
  author_association: string;
  pull_request?: unknown;
}

/**
 * Whether a high-confidence "duplicate" or "subset" may close the target in favor of `related`:
 * the related issue must be an open issue (not a pull request) filed by the project's own people.
 * Otherwise the deduper only comments and leaves closing to a maintainer.
 */
export function mayCloseInFavorOf(related: IssueRecord): boolean {
  return (
    related.pull_request === undefined &&
    related.state === "open" &&
    PROJECT_ASSOCIATIONS.has(related.author_association)
  );
}
