/**
 * One-time setup script to create the orphan `issues` branch.
 *
 * Usage: bun run .github/scripts/issues-deduper/setup-branch.ts
 *
 * This creates:
 * - An orphan branch named `issues` (no shared history with main)
 * - CLAUDE.md with guidelines for the deduper agent
 * - last-processed.txt initialized to 0
 * - issues/ directory with .gitkeep
 */

import { $ } from "bun";

const BRANCH_NAME = "issues";

const CLAUDE_MD = `# Issues Branch

This branch contains a file-based representation of all GitHub issues
for efficient searching and deduplication by Claude Code.

## Structure

\`\`\`
issues/                    # Orphan branch (no shared history with main)
├── CLAUDE.md              # This file
├── last-processed.txt     # Tracks deduplication progress (highest checked issue number)
└── issues/
    ├── 1-initial-setup.md
    ├── 2-add-dark-mode.md
    └── ...
\`\`\`

## Issue File Format

Each issue file (\`issues/<number>-<slug>.md\`) contains:
- YAML frontmatter with metadata (number, title, labels, created, status)
- Full issue body in markdown

Example:
\`\`\`markdown
---
number: 123
title: "feature: Add dark mode support"
labels: [feature, ui]
created: 2025-01-15
status: open
---

Add a dark mode toggle to the settings page...
\`\`\`

## For Deduplication Agent

When checking a new issue for duplicates:

1. **Search for potential matches**: Use Grep to search for keywords from the issue title/body
   \`\`\`
   grep -r "dark mode" issues/
   grep -r "theme" issues/
   \`\`\`

2. **Read candidates**: Read the full content of potential matches to assess relationship

3. **Determine relationship type**:
   - \`duplicate\`: Same issue, different wording (close one)
   - \`subset\`: Target is fully covered by another issue (close target)
   - \`superset\`: Target fully covers another issue (other should close)
   - \`overlapping\`: Significant shared scope but each has unique value
   - \`related\`: Same domain/feature area but distinct scope

4. **Return structured JSON**: Output your analysis in the required schema

## Important Notes

- Focus on HIGH CONFIDENCE matches
- Better to miss a subtle duplicate than incorrectly flag unrelated issues
- If unsure, use "related" with "low" confidence rather than "duplicate"
- Consider the full context, not just keyword overlap
- Issues in the same project often share vocabulary - that doesn't make them duplicates
`;

async function main() {
  console.log(`Setting up orphan branch: ${BRANCH_NAME}`);

  // Check if branch already exists
  const branchExists = await $`git ls-remote --heads origin ${BRANCH_NAME}`.quiet().nothrow();
  if (branchExists.exitCode === 0 && branchExists.stdout.toString().trim()) {
    console.error(`Branch '${BRANCH_NAME}' already exists on remote.`);
    console.error("Delete it first if you want to recreate:");
    console.error(`  git push origin --delete ${BRANCH_NAME}`);
    process.exit(1);
  }

  // Save current branch to return to it later
  const currentBranch = await $`git rev-parse --abbrev-ref HEAD`.quiet().text();

  try {
    // Create orphan branch
    console.log("Creating orphan branch...");
    await $`git checkout --orphan ${BRANCH_NAME}`;

    // Remove all files from index
    await $`git rm -rf .`.quiet().nothrow();

    // Create directory structure
    console.log("Creating directory structure...");
    await $`mkdir -p issues`;

    // Write CLAUDE.md
    await Bun.write("CLAUDE.md", CLAUDE_MD);

    // Write last-processed.txt (start at 0)
    await Bun.write("last-processed.txt", "0\n");

    // Create .gitkeep in issues/
    await Bun.write("issues/.gitkeep", "");

    // Stage and commit
    console.log("Committing initial structure...");
    await $`git add CLAUDE.md last-processed.txt issues/.gitkeep`;
    await $`git commit -m "Initialize issues branch for deduplication"`;

    // Push to remote
    console.log("Pushing to remote...");
    await $`git push -u origin ${BRANCH_NAME}`;

    console.log(`\nOrphan branch '${BRANCH_NAME}' created successfully!`);
  } finally {
    // Return to original branch
    console.log(`Returning to branch: ${currentBranch.trim()}`);
    await $`git checkout ${currentBranch.trim()}`.quiet().nothrow();
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
