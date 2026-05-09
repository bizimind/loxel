import { describe, expect, test } from "bun:test";

import { createContentAnchor, relocateAnchor } from "./content-anchor";

const sampleLines = [
  "import { foo } from './foo';",
  "import { bar } from './bar';",
  "import { baz } from './baz';",
  "",
  "function main() {",
  "  const x = foo();",
  "  const y = bar();",
  "  const z = baz();",
  "  return x + y + z;",
  "}",
  "",
  "export default main;",
];

describe("createContentAnchor", () => {
  test("captures content and context", () => {
    const anchor = createContentAnchor(sampleLines, 6, 8);
    expect(anchor.content).toEqual([
      "  const x = foo();",
      "  const y = bar();",
      "  const z = baz();",
    ]);
    expect(anchor.contextBefore).toEqual(["import { baz } from './baz';", "", "function main() {"]);
    expect(anchor.contextAfter).toEqual(["  return x + y + z;", "}", ""]);
    expect(anchor.contentHash).toBeString();
    expect(anchor.contentHash.length).toBe(8);
  });

  test("limits context to available lines at start of file", () => {
    const anchor = createContentAnchor(sampleLines, 1, 2);
    expect(anchor.content).toEqual([
      "import { foo } from './foo';",
      "import { bar } from './bar';",
    ]);
    expect(anchor.contextBefore).toEqual([]);
    expect(anchor.contextAfter).toEqual(["import { baz } from './baz';", "", "function main() {"]);
  });

  test("limits context to available lines at end of file", () => {
    const anchor = createContentAnchor(sampleLines, 11, 12);
    expect(anchor.content).toEqual(["", "export default main;"]);
    expect(anchor.contextBefore).toEqual(["  const z = baz();", "  return x + y + z;", "}"]);
    expect(anchor.contextAfter).toEqual([]);
  });
});

describe("relocateAnchor", () => {
  test("exact match at stored position", () => {
    const anchor = createContentAnchor(sampleLines, 6, 8);
    const result = relocateAnchor(anchor, sampleLines, 6);
    expect(result.status).toBe("exact");
    expect(result.startLine).toBe(6);
    expect(result.endLine).toBe(8);
  });

  test("relocated when lines inserted before", () => {
    const anchor = createContentAnchor(sampleLines, 6, 8);
    // Insert 2 blank lines at the top
    const shifted = ["// comment 1", "// comment 2", ...sampleLines];
    const result = relocateAnchor(anchor, shifted, 6);
    expect(result.status).toBe("relocated");
    expect(result.startLine).toBe(8);
    expect(result.endLine).toBe(10);
  });

  test("relocated when lines deleted before", () => {
    const anchor = createContentAnchor(sampleLines, 6, 8);
    // Remove first 2 lines
    const shifted = sampleLines.slice(2);
    const result = relocateAnchor(anchor, shifted, 6);
    expect(result.status).toBe("relocated");
    expect(result.startLine).toBe(4);
    expect(result.endLine).toBe(6);
  });

  test("outdated when content changed but context intact", () => {
    const anchor = createContentAnchor(sampleLines, 6, 8);
    const modified = [...sampleLines];
    // Change the commented lines but keep surrounding context
    modified[5] = "  const x = newFoo();";
    modified[6] = "  const y = newBar();";
    modified[7] = "  const z = newBaz();";
    const result = relocateAnchor(anchor, modified, 6);
    expect(result.status).toBe("outdated");
    expect(result.startLine).toBe(6);
    expect(result.endLine).toBe(8);
  });

  test("lost when content and context completely changed", () => {
    const anchor = createContentAnchor(sampleLines, 6, 8);
    const totallyDifferent = [
      "completely",
      "different",
      "file",
      "with",
      "no",
      "matching",
      "content",
      "whatsoever",
    ];
    const result = relocateAnchor(anchor, totallyDifferent, 6);
    expect(result.status).toBe("lost");
    expect(result.startLine).toBeNull();
    expect(result.endLine).toBeNull();
  });

  test("relocated globally when moved far from original position", () => {
    const anchor = createContentAnchor(sampleLines, 6, 8);
    // Move content to end of a much longer file
    const longFile = Array.from({ length: 50 }, (_, i) => `// filler line ${i}`);
    longFile.push("  const x = foo();", "  const y = bar();", "  const z = baz();");
    const result = relocateAnchor(anchor, longFile, 6);
    expect(result.status).toBe("relocated");
    expect(result.startLine).toBe(51);
    expect(result.endLine).toBe(53);
  });

  test("single line anchor", () => {
    const anchor = createContentAnchor(sampleLines, 5, 5);
    expect(anchor.content).toEqual(["function main() {"]);
    const result = relocateAnchor(anchor, sampleLines, 5);
    expect(result.status).toBe("exact");
    expect(result.startLine).toBe(5);
    expect(result.endLine).toBe(5);
  });
});
