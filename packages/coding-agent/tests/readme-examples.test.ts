import { describe, expect, test } from "bun:test";

import { protocolEventSchema, protocolRequestSchema } from "../src/protocol/schemas.ts";

function extractTaggedJsonBlocks(
  markdown: string,
  tag: "protocol-request" | "protocol-event",
): string[] {
  const startFence = `\`\`\`json ${tag}`;
  const endFence = "```";
  const blocks: string[] = [];
  const lines = markdown.split("\n");
  let collecting = false;
  let current: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!collecting && trimmed === startFence) {
      collecting = true;
      current = [];
      continue;
    }

    if (!collecting) {
      continue;
    }

    if (trimmed === endFence) {
      blocks.push(current.join("\n").trim());
      collecting = false;
      current = [];
      continue;
    }

    current.push(line);
  }

  return blocks;
}

describe("README protocol examples", () => {
  test("protocol-request JSON blocks parse against protocolRequestSchema", async () => {
    const markdown = await Bun.file(new URL("../README.md", import.meta.url)).text();
    const blocks = extractTaggedJsonBlocks(markdown, "protocol-request");
    expect(blocks.length).toBeGreaterThan(0);

    for (const block of blocks) {
      const payload = JSON.parse(block) as unknown;
      protocolRequestSchema.parse(payload);
    }
  });

  test("protocol-event JSON blocks parse against protocolEventSchema", async () => {
    const markdown = await Bun.file(new URL("../README.md", import.meta.url)).text();
    const blocks = extractTaggedJsonBlocks(markdown, "protocol-event");
    expect(blocks.length).toBeGreaterThan(0);

    for (const block of blocks) {
      const payload = JSON.parse(block) as unknown;
      protocolEventSchema.parse(payload);
    }
  });
});
