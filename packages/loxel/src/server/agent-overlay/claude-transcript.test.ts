import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TranscriptModel, TranscriptTailer } from "./claude-transcript";

const FIXTURE = join(import.meta.dir, "fixtures", "claude-2.1.325", "transcript.jsonl");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("TranscriptModel", () => {
  test("a recorded session: prompts, replies, tool uses with their results, title and mode", () => {
    const model = new TranscriptModel();
    for (const line of readFileSync(FIXTURE, "utf8").trim().split("\n")) {
      model.apply(JSON.parse(line));
    }
    const summary = model.all().map((item) => {
      if (item.kind === "tool") return `tool:${item.name}:${item.result ? "done" : "pending"}`;
      if (item.kind === "user" || item.kind === "assistant") {
        return `${item.kind}:${item.text.slice(0, 24)}`;
      }
      return item.kind;
    });
    expect(summary).toEqual([
      "user:Run exactly this bash co",
      "tool:Bash:done",
      "assistant:The command printed `42`",
      "user:Use the AskUserQuestion ",
      "tool:AskUserQuestion:done",
      "assistant:Color: Blue; Fruits: App",
      "user:Plan how to create a fil",
      // In plan mode, Claude tried Write (refused) and loaded a deferred tool first.
      "tool:Write:done",
      "tool:ToolSearch:done",
      "tool:ExitPlanMode:done",
      "system",
    ]);
    const bash = model.all().find((item) => item.kind === "tool" && item.name === "Bash");
    expect(bash).toMatchObject({
      input: { command: "python3 -c 'print(6*7)'" },
      result: { text: "42", isError: false },
    });
    expect(model.title).toBeString();
    expect(model.permissionMode).toBe("plan");
  });

  test("slash commands carry their local output; interruptions show as system items", () => {
    const model = new TranscriptModel();
    const user = (uuid: string, content: string) => ({
      type: "user",
      uuid,
      message: { role: "user", content },
    });
    model.apply(user("a", "<command-name>/context</command-name>\n<command-args></command-args>"));
    const changed = model.apply(user("b", "<local-command-stdout>42% used</local-command-stdout>"));
    model.apply(user("c", "[Request interrupted by user]"));
    model.apply({ type: "user", uuid: "d", isMeta: true, message: { content: "skill body" } });
    expect(changed).toEqual([
      { kind: "command", id: "a", name: "/context", args: "", output: "42% used" },
    ]);
    expect(model.all().map((item) => item.kind)).toEqual(["command", "system"]);
  });
});

describe("TranscriptTailer", () => {
  test("reads complete lines only, then what is appended, and starts over on truncation", () => {
    const dir = mkdtempSync(join(tmpdir(), "transcript-"));
    dirs.push(dir);
    const path = join(dir, "session.jsonl");
    writeFileSync(path, '{"n":1}\n{"n":');
    const batches: { records: unknown[]; reset: boolean }[] = [];
    const tailer = new TranscriptTailer(path, (records, reset) => batches.push({ records, reset }));
    tailer.read();
    appendFileSync(path, '2}\n{"n":3}\n');
    tailer.read();
    writeFileSync(path, '{"n":9}\n');
    tailer.read();
    tailer.stop();
    expect(batches).toEqual([
      { records: [{ n: 1 }], reset: false },
      { records: [{ n: 2 }, { n: 3 }], reset: false },
      { records: [{ n: 9 }], reset: true },
    ]);
  });
});
