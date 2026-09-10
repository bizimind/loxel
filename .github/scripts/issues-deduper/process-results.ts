/**
 * Process deduplication results and take actions on GitHub.
 *
 * Usage: bun run process-results.ts <issue_number> [--dry-run]
 *
 * Actions based on relationship type and confidence:
 * - duplicate (high): Close as duplicate of older issue
 * - duplicate (medium/low): Comment linking, don't close
 * - subset (high): Close, add unique_value as comment to superset
 * - subset (medium/low): Comment "May be covered by #X"
 * - superset (high): Comment on related issue suggesting closure
 * - superset (medium/low): Link bidirectionally
 * - overlapping: Link bidirectionally
 * - related: Link bidirectionally
 */

import { $ } from "bun";

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

async function processRelation(targetIssue: number, relation: Relation): Promise<void> {
  const { related_issue, relationship, confidence, reasoning, unique_value } = relation;

  console.log(`Processing: #${targetIssue} -> #${related_issue} (${relationship}, ${confidence})`);

  // Build concise one-line comment format: "Type: #issue - reason"
  const typeLabels: Record<string, string> = {
    duplicate: "Duplicate",
    subset: "Covered by",
    superset: "Covers",
    overlapping: "Overlaps",
    related: "Related",
  };

  const label = typeLabels[relationship];

  switch (relationship) {
    case "duplicate": {
      await commentOnIssue(targetIssue, `${label}: #${related_issue} - ${reasoning}`);

      if (confidence === "high") {
        const closeComment = unique_value
          ? `Closing as duplicate of #${related_issue}.\n\n**Preserved context:** ${unique_value}`
          : `Closing as duplicate of #${related_issue}.`;
        await closeIssue(targetIssue, closeComment, related_issue);

        if (unique_value) {
          await commentOnIssue(related_issue, `Context from #${targetIssue}: ${unique_value}`);
        }
      }
      break;
    }

    case "subset": {
      await commentOnIssue(targetIssue, `${label}: #${related_issue} - ${reasoning}`);

      if (confidence === "high") {
        const closeComment = unique_value
          ? `Closing as covered by #${related_issue}.\n\n**Preserved context:** ${unique_value}`
          : `Closing as covered by #${related_issue}.`;
        await closeIssue(targetIssue, closeComment, related_issue);

        if (unique_value) {
          await commentOnIssue(related_issue, `Context from #${targetIssue}: ${unique_value}`);
        }
      }
      break;
    }

    case "superset": {
      await commentOnIssue(targetIssue, `${label}: #${related_issue} - ${reasoning}`);
      await commentOnIssue(related_issue, `Covered by: #${targetIssue} - ${reasoning}`);
      break;
    }

    case "overlapping": {
      await commentOnIssue(targetIssue, `${label}: #${related_issue} - ${reasoning}`);
      await commentOnIssue(related_issue, `${label}: #${targetIssue} - ${reasoning}`);
      break;
    }

    case "related": {
      await commentOnIssue(targetIssue, `${label}: #${related_issue} - ${reasoning}`);
      await commentOnIssue(related_issue, `${label}: #${targetIssue} - ${reasoning}`);
      break;
    }

    default: {
      const _exhaustive: never = relationship;
      throw new Error(`Unknown relationship: ${String(_exhaustive)}`);
    }
  }
}

async function main() {
  const issueNumber = process.argv[2];

  if (!issueNumber || issueNumber === "--dry-run") {
    console.error("Usage: bun run process-results.ts <issue_number> [--dry-run]");
    process.exit(1);
  }

  const resultFile = `results/${issueNumber}.json`;

  // Check if result file exists
  const file = Bun.file(resultFile);
  if (!(await file.exists())) {
    console.error(`Result file not found: ${resultFile}`);
    process.exit(1);
  }

  // Read and validate result
  const result: DedupeResult = await file.json();

  try {
    validateDedupeResult(result);
  } catch (err) {
    console.error(`Invalid result format: ${err}`);
    process.exit(1);
  }

  console.log(`Processing results for issue #${issueNumber}`);
  console.log(`Found ${result.relations.length} relations`);

  if (DRY_RUN) {
    console.log("\n=== DRY RUN MODE - No changes will be made ===\n");
  }

  // Process each relation
  for (const relation of result.relations) {
    await processRelation(parseInt(issueNumber, 10), relation);
  }

  console.log("\nDone processing results");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
