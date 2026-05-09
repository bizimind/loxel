import { describe, expect, test } from "bun:test";

const REQUIRED_SOURCE_LINKS = [
  "./src/protocol/schemas.ts",
  "./src/tools/schemas.ts",
  "./src/session/store.ts",
  "./src/state/layout.ts",
  "./src/orchestrator/model-router.ts",
  "./src/permissions/store.ts",
] as const;

function extractMarkdownLinks(markdown: string): string[] {
  const pattern = /\[[^\]]+\]\(([^)]+)\)/g;
  const links: string[] = [];
  let match = pattern.exec(markdown);

  while (match) {
    if (match[1]) {
      links.push(match[1].trim());
    }
    match = pattern.exec(markdown);
  }

  return links;
}

function normalizeLocalLink(target: string): string | null {
  if (
    target.startsWith("http://") ||
    target.startsWith("https://") ||
    target.startsWith("mailto:") ||
    target.startsWith("#")
  ) {
    return null;
  }

  const noFragment = target.split("#")[0]?.split("?")[0]?.trim();
  if (!noFragment) {
    return null;
  }
  return noFragment;
}

describe("README links", () => {
  test("local links resolve to existing files", async () => {
    const readmeUrl = new URL("../README.md", import.meta.url);
    const markdown = await Bun.file(readmeUrl).text();
    const links = extractMarkdownLinks(markdown);
    const localLinks = links
      .map((target) => normalizeLocalLink(target))
      .filter((target): target is string => Boolean(target));

    expect(localLinks.length).toBeGreaterThan(0);

    for (const target of localLinks) {
      const resolved = new URL(target, readmeUrl);
      const exists = await Bun.file(resolved).exists();
      expect(exists).toBe(true);
    }
  });

  test("contains required source-of-truth links", async () => {
    const markdown = await Bun.file(new URL("../README.md", import.meta.url)).text();
    const links = extractMarkdownLinks(markdown);
    const normalized = new Set(
      links
        .map((target) => normalizeLocalLink(target))
        .filter((target): target is string => Boolean(target)),
    );

    for (const required of REQUIRED_SOURCE_LINKS) {
      expect(normalized.has(required)).toBe(true);
    }
  });
});
