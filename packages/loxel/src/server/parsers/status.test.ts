import { describe, expect, test } from "bun:test";

import { parseStatusOutput } from "./status";

describe("parseStatusOutput", () => {
  test("parses branch info", () => {
    const output = `# branch.oid abc123
# branch.head main
# branch.upstream origin/main
# branch.ab +2 -1`;

    const status = parseStatusOutput(output);

    expect(status.branch).toBe("main");
    expect(status.commit).toBe("abc123");
    expect(status.upstream).toBe("origin/main");
    expect(status.ahead).toBe(2);
    expect(status.behind).toBe(1);
  });

  test("parses detached HEAD", () => {
    const output = `# branch.oid abc123
# branch.head (detached)`;

    const status = parseStatusOutput(output);

    expect(status.branch).toBeNull();
    expect(status.commit).toBe("abc123");
  });

  test("parses staged and unstaged changes", () => {
    const output = `# branch.oid abc123
# branch.head main
1 M. N... 100644 100644 100644 abc123 def456 src/modified.ts
1 .M N... 100644 100644 100644 abc123 def456 src/unstaged.ts
1 MM N... 100644 100644 100644 abc123 def456 src/both.ts`;

    const status = parseStatusOutput(output);

    expect(status.staged).toHaveLength(2);
    expect(status.unstaged).toHaveLength(2);
    expect(status.staged[0]!.path).toBe("src/modified.ts");
    expect(status.staged[0]!.status).toBe("M");
  });

  test("parses untracked files", () => {
    const output = `# branch.oid abc123
# branch.head main
? newfile.ts
? another/file.ts`;

    const status = parseStatusOutput(output);

    expect(status.untracked).toEqual(["newfile.ts", "another/file.ts"]);
  });

  test("parses added files", () => {
    const output = `# branch.oid abc123
# branch.head main
1 A. N... 000000 100644 100644 0000000 abc123 src/new.ts`;

    const status = parseStatusOutput(output);

    expect(status.staged).toHaveLength(1);
    expect(status.staged[0]!.status).toBe("A");
    expect(status.staged[0]!.path).toBe("src/new.ts");
  });
});
