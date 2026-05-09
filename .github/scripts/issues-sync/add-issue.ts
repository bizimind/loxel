/**
 * Generates an issue markdown file from environment variables.
 *
 * Expected env vars (set by GitHub Actions):
 * - ISSUE_NUMBER: Issue number
 * - ISSUE_TITLE: Issue title
 * - ISSUE_BODY: Issue body (markdown)
 * - ISSUE_LABELS: JSON array of label names
 * - ISSUE_CREATED: ISO timestamp
 *
 * Outputs: issues/<number>-<slug>.md
 */

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // Replace non-alphanumeric with hyphens
    .replace(/^-+|-+$/g, "") // Trim leading/trailing hyphens
    .substring(0, 50); // Limit length
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
  const number = process.env.ISSUE_NUMBER;
  const title = process.env.ISSUE_TITLE;
  const body = process.env.ISSUE_BODY || "";
  const labelsJson = process.env.ISSUE_LABELS || "[]";
  const created = process.env.ISSUE_CREATED;

  if (!number || !title || !created) {
    console.error("Missing required environment variables:");
    console.error("  ISSUE_NUMBER:", number);
    console.error("  ISSUE_TITLE:", title);
    console.error("  ISSUE_CREATED:", created);
    process.exit(1);
  }

  const labels: string[] = JSON.parse(labelsJson);
  const slug = slugify(title);
  const filename = `issues/${number}-${slug}.md`;

  // Format labels as YAML array
  const labelsYaml =
    labels.length > 0 ? `[${labels.map((l) => JSON.stringify(l)).join(", ")}]` : "[]";

  // Build the markdown file content
  const content = `---
number: ${number}
title: ${escapeYamlString(title)}
labels: ${labelsYaml}
created: ${created.split("T")[0]}
status: open
---

${body}
`;

  await Bun.write(filename, content);
  console.log(`Created: ${filename}`);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
