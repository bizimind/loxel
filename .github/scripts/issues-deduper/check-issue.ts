/**
 * Check a single issue for duplicates/related issues.
 *
 * Usage: bun run check-issue.ts <issue_number>
 *
 * This script:
 * 1. Reads the target issue file from issues/<number>-*.md
 * 2. Builds a prompt for Claude Code
 * 3. Invokes Claude CLI with JSON schema output
 * 4. Writes the result to results/<number>.json
 */

import { $ } from "bun";

import { DEDUPE_RESULT_SCHEMA, validateDedupeResult } from "./schema.ts";

const PROMPT_TEMPLATE = `You are analyzing GitHub issue #{{ISSUE_NUMBER}} for duplicates and related issues.

## Target Issue

{{ISSUE_CONTENT}}

## Instructions

1. Read the CLAUDE.md file at the root to understand the context
2. Use Glob to find issue files: issues/*.md
3. Search for related issues by grepping for key terms from the issue title and body
4. Read promising candidates to assess the relationship
5. For each potential match, determine the relationship type
6. Return your analysis as JSON

Note: You only have access to Read, Grep, and Glob tools. Do NOT try to use Bash, Edit, or Write.

## Relationship Types

- \`duplicate\`: Same issue, different wording. One should be closed.
- \`subset\`: This issue (#{{ISSUE_NUMBER}}) is FULLY covered by another issue. This issue should be closed.
- \`superset\`: This issue (#{{ISSUE_NUMBER}}) FULLY covers another issue. The other should be closed.
- \`overlapping\`: Significant shared scope but EACH has unique value. Keep both, link them.
- \`related\`: Same domain/feature area but distinct scope. Link them.

## Important Guidelines

- Focus on HIGH CONFIDENCE matches only
- It's better to miss a subtle duplicate than incorrectly flag unrelated issues
- Issues in the same project often share vocabulary - that alone doesn't make them duplicates
- If unsure, use "related" with "low" confidence rather than "duplicate"
- Only report relationships you're confident about; empty relations array is fine
- The unique_value field should capture any info worth preserving if closing an issue

## Reasoning Format

CRITICAL: The reasoning field must be VERY CONCISE - a single short phrase (5-15 words max).
Use informal language - no need to be formal or verbose.

For duplicates: explain what makes them the same issue.
For non-duplicates (related, overlapping, subset, superset): explain BOTH the connection AND what makes them distinct.

Good examples:
- duplicate: "same dark mode toggle request"
- related: "both touch auth; this is UX, that is architecture"
- overlapping: "both add token refresh; this is CLI, that is library"
- subset: "covered by that broader refactor"

Bad: "Issue #123 discusses implementing token refresh which is related to..."

Do NOT reference issue numbers - the comment already shows which issues are linked.

## Output

Return ONLY valid JSON. No explanation text before or after.
`;

async function findIssueFile(issueNumber: string): Promise<string | null> {
  const files = await $`ls issues/`.quiet().text();
  for (const file of files.split("\n")) {
    if (file.trim().startsWith(`${issueNumber}-`)) {
      return `issues/${file.trim()}`;
    }
  }
  return null;
}

async function main() {
  const issueNumber = process.argv[2];

  if (!issueNumber || !/^\d+$/.test(issueNumber)) {
    console.error("Usage: bun run check-issue.ts <issue_number>");
    console.error("Issue number must be a positive integer");
    process.exit(1);
  }

  // Find the issue file
  const issueFile = await findIssueFile(issueNumber);
  if (!issueFile) {
    console.error(`Issue file not found for #${issueNumber}`);
    process.exit(1);
  }

  // Read the issue content
  const issueContent = await Bun.file(issueFile).text();

  // Build the prompt
  const prompt = PROMPT_TEMPLATE.replace(/\{\{ISSUE_NUMBER\}\}/g, issueNumber).replace(
    "{{ISSUE_CONTENT}}",
    issueContent,
  );

  console.log(`Checking issue #${issueNumber} for duplicates...`);

  // Write prompt to temp file to avoid shell escaping issues
  const promptFile = `/tmp/dedupe-prompt-${issueNumber}.txt`;
  await Bun.write(promptFile, prompt);

  // Build JSON schema string
  const schemaJson = JSON.stringify(DEDUPE_RESULT_SCHEMA);

  try {
    // Use Bun.spawn for better control over argument handling
    const promptContent = await Bun.file(promptFile).text();

    const proc = Bun.spawn(
      [
        "claude",
        "-p",
        "--output-format",
        "json",
        "--json-schema",
        schemaJson,
        "--tools",
        "Read,Grep,Glob", // Restrict to read-only tools
        "--max-turns",
        "25",
        "--no-session-persistence",
        "--setting-sources",
        "",
        "--agents",
        "{}",
      ],
      { stdin: new Blob([promptContent]), stdout: "pipe", stderr: "pipe" },
    );

    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    if (exitCode !== 0) {
      console.error("Claude CLI failed:", stderr);
      process.exit(1);
    }

    const output = JSON.parse(stdout);

    // Log response metadata
    console.log(
      "Response: type=%s subtype=%s turns=%d",
      output.type,
      output.subtype,
      output.num_turns,
    );

    // Check for max turns error
    if (output.subtype === "error_max_turns") {
      console.error("Agent hit max turns limit without returning structured output");
      console.error("Consider increasing --max-turns or simplifying the task");
      process.exit(1);
    }

    // Extract the structured output (with fallback)
    let dedupeResult = output.structured_output;

    if (!dedupeResult) {
      console.error("No structured_output in response");
      console.error("Response keys:", Object.keys(output).join(", "));

      // Check if there was an error
      if (output.is_error) {
        console.error("Claude returned an error:", output.result);
        process.exit(1);
      }

      // Try to extract JSON from the result text as fallback
      if (output.result) {
        const jsonMatch = output.result.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            dedupeResult = JSON.parse(jsonMatch[0]);
            console.log("Extracted JSON from result text");
          } catch {
            console.error("Failed to parse JSON from result");
          }
        }
      }

      if (!dedupeResult) {
        console.error("Could not extract structured output");
        process.exit(1);
      }
    }

    // Validate the result matches our schema
    try {
      validateDedupeResult(dedupeResult);
    } catch (err) {
      console.error("Invalid result from Claude:", err);
      console.error("Result was:", JSON.stringify(dedupeResult, null, 2).substring(0, 500));
      process.exit(1);
    }

    // Create results directory if needed
    await $`mkdir -p results`.quiet();

    // Write result to file
    const resultFile = `results/${issueNumber}.json`;
    await Bun.write(resultFile, JSON.stringify(dedupeResult, null, 2));

    console.log(`Result written to ${resultFile}`);
    console.log(`Found ${dedupeResult.relations?.length || 0} related issues`);
  } finally {
    // Clean up temp file
    await $`rm -f ${promptFile}`.quiet();
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
