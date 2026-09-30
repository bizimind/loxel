import { describe, expect, test } from "bun:test";

import { parseStatusOutput } from "./status";

/** Join records the way `git status --porcelain=v2 -z` terminates them. */
function z(...records: string[]): string {
  return records.map((record) => `${record}\0`).join("");
}

describe("parseStatusOutput", () => {
  test("parses branch info", () => {
    const output = z(
      "# branch.oid abc123",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +2 -1",
    );

    const status = parseStatusOutput(output);

    expect(status.branch).toBe("main");
    expect(status.commit).toBe("abc123");
    expect(status.upstream).toBe("origin/main");
    expect(status.ahead).toBe(2);
    expect(status.behind).toBe(1);
  });

  test("parses detached HEAD", () => {
    const output = z("# branch.oid abc123", "# branch.head (detached)");

    const status = parseStatusOutput(output);

    expect(status.branch).toBeNull();
    expect(status.commit).toBe("abc123");
  });

  test("parses staged and unstaged changes", () => {
    const output = z(
      "# branch.oid abc123",
      "# branch.head main",
      "1 M. N... 100644 100644 100644 abc123 def456 src/modified.ts",
      "1 .M N... 100644 100644 100644 abc123 def456 src/unstaged.ts",
      "1 MM N... 100644 100644 100644 abc123 def456 src/both.ts",
    );

    const status = parseStatusOutput(output);

    expect(status.staged).toHaveLength(2);
    expect(status.unstaged).toHaveLength(2);
    expect(status.staged[0]!.path).toBe("src/modified.ts");
    expect(status.staged[0]!.status).toBe("M");
  });

  test("parses untracked files and directories", () => {
    const output = z("# branch.oid abc123", "# branch.head main", "? newfile.ts", "? new dir/");

    const status = parseStatusOutput(output);

    expect(status.untracked).toEqual(["newfile.ts", "new dir/"]);
  });

  test("parses added files", () => {
    const output = z(
      "# branch.oid abc123",
      "# branch.head main",
      "1 A. N... 000000 100644 100644 0000000 abc123 src/new.ts",
    );

    const status = parseStatusOutput(output);

    expect(status.staged).toHaveLength(1);
    expect(status.staged[0]!.status).toBe("A");
    expect(status.staged[0]!.path).toBe("src/new.ts");
  });

  test("reads a rename's original path from the following record", () => {
    const output = z(
      "2 R. N... 100644 100644 100644 abc123 abc123 R100 new name.ts",
      "old name.ts",
      "? after.ts",
    );

    const status = parseStatusOutput(output);

    expect(status.staged).toEqual([{ path: "new name.ts", oldPath: "old name.ts", status: "R" }]);
    // The original path must be consumed, not mistaken for a record of its own.
    expect(status.untracked).toEqual(["after.ts"]);
  });

  test("keeps paths git would otherwise C-quote verbatim", () => {
    const output = z(
      "1 .M N... 100644 100644 100644 abc123 def456 dir/sp ace.txt",
      "? ünï.txt",
      '? q"uote.txt',
    );

    const status = parseStatusOutput(output);

    expect(status.unstaged[0]!.path).toBe("dir/sp ace.txt");
    expect(status.untracked).toEqual(["ünï.txt", 'q"uote.txt']);
  });

  test("parses unmerged entries", () => {
    const output = z("u UU N... 100644 100644 100644 100644 aaa bbb ccc src/conflict file.ts");

    const status = parseStatusOutput(output);

    expect(status.conflicted).toEqual([{ path: "src/conflict file.ts", status: "U" }]);
  });
});
