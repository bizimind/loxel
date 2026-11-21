/**
 * Process deduplication results and take actions on GitHub.
 *
 * Usage: bun run process-results.ts <issue_number> [--dry-run]
 *
 * Runs in the issues branch checkout, with results/<issue_number>.json from check-issue.ts. Only
 * relations that pass policy.ts are acted on, and model text reaches comments only through
 * commentText():
 * - duplicate / subset: comment on this issue; at high confidence, close it when the related issue
 *   is an open issue filed by someone with write access (otherwise a maintainer decides), and copy
 *   unique_value to the related issue
 * - superset: comment on both issues
 * - overlapping, related: link both issues
 */

import { $ } from "bun";

import {
  checkRelations,
  commentText,
  type IssueRecord,
  MAX_REASONING_LENGTH,
  MAX_UNIQUE_VALUE_LENGTH,
  mayCloseInFavorOf,
} from "./policy.ts";
import type { DedupeResult, Relation } from "./schema.ts";
import { validateDedupeResult } from "./schema.ts";

const DRY_RUN = process.argv.includes("--dry-run");

async function commentOnIssue(issueNumber: number, body: string): Promise<void> {
  if (DRY_RUN) {
    console.log(`[DRY-RUN] Would comment on #${issueNumber}:\n${body}\n`);
    return;
  }
  try {
    await $`gh issue comment ${issueNumber} --body ${body}`;
    console.log(`Commented on #${issueNumber}`);
  } catch (err) {
    console.error(`Failed to comment on #${issueNumber}:`, err);
    // Continue processing other relations instead of aborting
  }
}

async function closeIssue(
  issueNumber: number,
  reason: string,
  duplicateOf?: number,
): Promise<void> {
  if (DRY_RUN) {
    console.log(
      `[DRY-RUN] Would close #${issueNumber}${duplicateOf ? ` as duplicate of #${duplicateOf}` : ""}: ${reason}`,
    );
    return;
  }
  try {
    // GitHub CLI only supports "completed" or "not planned" as close reasons
    // Use "not planned" for duplicates since work will be done in the other issue
    const closeReason = duplicateOf ? "not planned" : "completed";
    await $`gh issue close ${issueNumber} --reason ${closeReason} --comment ${reason}`;
    console.log(`Closed #${issueNumber}`);
  } catch (err) {
    console.error(`Failed to close #${issueNumber}:`, err);
    // Continue processing other relations instead of aborting
  }
}

/** Read-only GitHub lookup; null when the response is not what was asked for. */
async function getJson(endpoint: string): Promise<unknown> {
  try {
    // Passed as one argument so the shell leaves gh's {owner}/{repo} placeholders alone.
    return await $`gh api ${endpoint}`.quiet().json();
  } catch (err) {
    console.error(`Failed to read ${endpoint}:`, err);
    return null;
  }
}

function field(record: unknown, key: string): unknown {
  return typeof record === "object" && record !== null && key in record
    ? (record as Record<string, unknown>)[key]
    : undefined;
}

async function fetchIssue(issueNumber: number): Promise<IssueRecord | null> {
  const issue = await getJson(`repos/{owner}/{repo}/issues/${issueNumber}`);
  const state = field(issue, "state");
  const login = field(field(issue, "user"), "login");
  if (typeof state !== "string" || typeof login !== "string") return null;

  const permission = field(
    await getJson(`repos/{owner}/{repo}/collaborators/${encodeURIComponent(login)}/permission`),
    "permission",
  );
  return {
    state,
    isPullRequest: field(issue, "pull_request") !== undefined,
    authorPermission: typeof permission === "string" ? permission : "none",
  };
}

const TYPE_LABELS: Record<Relation["relationship"], string> = {
  duplicate: "Duplicate",
  subset: "Covered by",
  superset: "Covers",
  overlapping: "Overlaps",
  related: "Related",
};

async function closeInFavorOf(
  targetIssue: number,
  relatedIssue: number,
  verb: string,
  uniqueValue: string | null,
): Promise<void> {
  const related = await fetchIssue(relatedIssue);
  if (!(related && mayCloseInFavorOf(related))) {
    console.log(
      `Not closing #${targetIssue}: #${relatedIssue} is not an open issue filed by someone with write access; left to a maintainer`,
    );
    return;
  }
  const closeComment = uniqueValue
    ? `Closing as ${verb} #${relatedIssue}.\n\n**Preserved context:** ${uniqueValue}`
    : `Closing as ${verb} #${relatedIssue}.`;
  await closeIssue(targetIssue, closeComment, relatedIssue);
  if (uniqueValue) {
    await commentOnIssue(relatedIssue, `Context from #${targetIssue}: ${uniqueValue}`);
  }
}

async function processRelation(targetIssue: number, relation: Relation): Promise<void> {
  const { related_issue: relatedIssue, relationship, confidence } = relation;
  const reasoning = commentText(relation.reasoning, MAX_REASONING_LENGTH);
  const uniqueValue = commentText(relation.unique_value, MAX_UNIQUE_VALUE_LENGTH);
  const link = (label: string, issue: number) =>
    reasoning ? `${label}: #${issue} - ${reasoning}` : `${label}: #${issue}`;

  console.log(`Processing: #${targetIssue} -> #${relatedIssue} (${relationship}, ${confidence})`);
  const label = TYPE_LABELS[relationship];

  switch (relationship) {
    case "duplicate":
    case "subset": {
      await commentOnIssue(targetIssue, link(label, relatedIssue));
      if (confidence === "high") {
        const verb = relationship === "duplicate" ? "duplicate of" : "covered by";
        await closeInFavorOf(targetIssue, relatedIssue, verb, uniqueValue);
      }
      break;
    }

    case "superset": {
      await commentOnIssue(targetIssue, link(label, relatedIssue));
      await commentOnIssue(relatedIssue, link("Covered by", targetIssue));
      break;
    }

    case "overlapping":
    case "related": {
      await commentOnIssue(targetIssue, link(label, relatedIssue));
      await commentOnIssue(relatedIssue, link(label, targetIssue));
      break;
    }

    default: {
      const _exhaustive: never = relationship;
      throw new Error(`Unknown relationship: ${String(_exhaustive)}`);
    }
  }
}

/** Issue numbers stored on the issues branch (issues/<number>-<slug>.md). */
async function knownIssues(): Promise<Set<number>> {
  const numbers = new Set<number>();
  for await (const file of new Bun.Glob("issues/*.md").scan(".")) {
    const match = /^issues\/(\d+)-/.exec(file);
    if (match) numbers.add(Number(match[1]));
  }
  return numbers;
}

async function main() {
  const issueNumber = process.argv[2];

  if (!issueNumber || !/^\d+$/.test(issueNumber)) {
    console.error("Usage: bun run process-results.ts <issue_number> [--dry-run]");
    process.exit(1);
  }
  const target = Number(issueNumber);

  const file = Bun.file(`results/${issueNumber}.json`);
  if (!(await file.exists())) {
    console.error(`Result file not found: results/${issueNumber}.json`);
    process.exit(1);
  }

  const result: DedupeResult = await file.json();
  try {
    validateDedupeResult(result);
  } catch (err) {
    console.error(`Invalid result format: ${err}`);
    process.exit(1);
  }

  const accepted = checkRelations(result, target, await knownIssues());
  console.log(`Processing results for issue #${issueNumber}`);
  console.log(`Acting on ${accepted.length} of ${result.relations.length} relation(s)`);

  if (DRY_RUN) {
    console.log("\n=== DRY RUN MODE - No changes will be made ===\n");
  }

  for (const relation of accepted) {
    await processRelation(target, relation);
  }

  console.log("\nDone processing results");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
