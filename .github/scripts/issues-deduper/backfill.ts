/**
 * Backfill existing open issues to the issues branch.
 *
 * Usage: bun run backfill.ts
 *
 * This script:
 * 1. Fetches all open issues using gh issue list
 * 2. Creates markdown files for each issue in issues/
 * 3. Should be run from within the issues branch checkout
 *
 * Run this manually after setting up the orphan branch to sync existing issues.
 */

import { $ } from "bun";

interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  labels: { name: string }[];
  createdAt: string;
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 50);
}

function escapeYamlString(str: string): string {
  // YAML special values that need quoting
  const yamlSpecials = /^(true|false|yes|no|on|off|null|~|\d+\.?\d*|0x[\da-f]+)$/i;

  // Quote if: special chars, newlines, leading/trailing whitespace, or YAML special values
  if (
    /[:[\]{}#&*!|>'"%@`]/.test(str) ||
    str.includes("\n") ||
    str !== str.trim() ||
    yamlSpecials.test(str)
  ) {
    return JSON.stringify(str);
  }
  return str;
}

async function main() {
  console.log("Fetching open issues from GitHub...");

  // Fetch all open issues
  const result =
    await $`gh issue list --state open --json number,title,body,labels,createdAt --limit 1000`.quiet();
  const issues: GitHubIssue[] = JSON.parse(result.stdout.toString());

  console.log(`Found ${issues.length} open issues`);

  // Ensure issues directory exists
  await $`mkdir -p issues`.quiet();

  let created = 0;
  let skipped = 0;

  for (const issue of issues) {
    const slug = slugify(issue.title);
    const filename = `issues/${issue.number}-${slug}.md`;

    // Check if file already exists
    const file = Bun.file(filename);
    if (await file.exists()) {
      console.log(`Skipping #${issue.number} (already exists)`);
      skipped++;
      continue;
    }

    // Format labels as YAML array
    const labelNames = issue.labels.map((l) => l.name);
    const labelsYaml =
      labelNames.length > 0 ? `[${labelNames.map((l) => JSON.stringify(l)).join(", ")}]` : "[]";

    // Build the markdown file content
    const content = `---
number: ${issue.number}
title: ${escapeYamlString(issue.title)}
labels: ${labelsYaml}
created: ${issue.createdAt.split("T")[0]}
status: open
---

${issue.body || ""}
`;

    await Bun.write(filename, content);
    console.log(`Created: ${filename}`);
    created++;
  }

  console.log("");
  console.log("Summary:");
  console.log(`  Created: ${created}`);
  console.log(`  Skipped: ${skipped}`);
  console.log(`  Total:   ${issues.length}`);

  if (created > 0) {
    console.log("");
    console.log("Next steps:");
    console.log("  1. Review the created files");
    console.log("  2. git add issues/");
    console.log('  3. git commit -m "Backfill existing issues"');
    console.log("  4. git push");
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
