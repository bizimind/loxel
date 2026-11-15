import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendPromptHistory, projectPrompts, readPromptHistory } from "./claude-history";

const line = (display: string, project: string) =>
  JSON.stringify({ display, pastedContents: {}, timestamp: 1, project, sessionId: "s" });

describe("prompt history", () => {
  test("a project's prompts, oldest first, repeats in a row merged, other projects left out", () => {
    const content = [
      line("first", "/p"),
      line("elsewhere", "/q"),
      line("again", "/p"),
      line("again", "/p"),
      "not json",
      line("last", "/p"),
    ].join("\n");
    expect(projectPrompts(content, "/p")).toEqual(["first", "again", "last"]);
  });

  test("the panel's prompts are appended in the TUI's shape and read back", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loxel-history-"));
    try {
      await Bun.write(join(dir, "history.jsonl"), `${line("from the TUI", "/p")}\n`);
      await appendPromptHistory(dir, { display: "from the panel", project: "/p", sessionId: "s2" });
      expect(await readPromptHistory(dir, "/p")).toEqual(["from the TUI", "from the panel"]);
      const last = JSON.parse(
        (await Bun.file(join(dir, "history.jsonl")).text()).trim().split("\n").at(-1)!,
      );
      expect(Object.keys(last).toSorted()).toEqual([
        "display",
        "pastedContents",
        "project",
        "sessionId",
        "timestamp",
      ]);
      expect(await readPromptHistory(join(dir, "missing"), "/p")).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
