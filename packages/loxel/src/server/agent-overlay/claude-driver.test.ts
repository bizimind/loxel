import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { AgentQuestion } from "@/api/agent-overlay-model";

import type { TerminalIO } from "./claude-driver";
import {
  FallbackError,
  answerPermission,
  answerPlan,
  answerQuestions,
  setPermissionMode,
  submitPrompt,
} from "./claude-driver";

function screen(name: string): string[] {
  return readFileSync(join(import.meta.dir, "fixtures", "claude-2.1.325", `${name}.txt`), "utf8")
    .replace(/\n$/u, "")
    .split("\n");
}

const OPTION_ROW = /^(\s*)(?:❯ )?(\s*)(\d+\.\s.*)$/u;

/** Moves the `❯` cursor of the dialog on `lines` to the option numbered `number`. */
function withCursor(lines: string[], number: number): string[] {
  let inDialog = false;
  return lines.map((line) => {
    if (/Do you want|Would you like to proceed|Ready to submit|Which \w+ do you/u.test(line)) {
      inDialog = true;
    }
    const match = inDialog ? OPTION_ROW.exec(line) : null;
    if (!match) return line;
    const body = match[3] ?? "";
    const indent = line.startsWith(" ") && !line.startsWith("  ") ? " " : "";
    return body.startsWith(`${number}.`) ? `${indent}❯ ${body}` : `${indent}  ${body}`;
  });
}

function cursorOf(lines: string[]): number {
  const row = lines.find((line) => /^\s*❯ \d+\./u.test(line));
  return Number(/❯ (\d+)\./u.exec(row ?? "")?.[1] ?? "1");
}

/**
 * A scripted stand-in for the TUI: the screen changes synchronously on each write, the way the real
 * screen has changed by the driver's next look.
 */
class FakeTui implements TerminalIO {
  readonly keys: string[] = [];
  constructor(
    public lines: string[],
    private readonly react: (key: string, tui: FakeTui) => void,
  ) {}
  screen(): Promise<readonly string[]> {
    return Promise.resolve(this.lines);
  }
  write(data: string): void {
    this.keys.push(data);
    this.react(data, this);
  }
}

function arrows(key: string, tui: FakeTui, max: number): boolean {
  const cursor = cursorOf(tui.lines);
  if (key === "\x1b[B") tui.lines = withCursor(tui.lines, Math.min(max, cursor + 1));
  else if (key === "\x1b[A") tui.lines = withCursor(tui.lines, Math.max(1, cursor - 1));
  else return false;
  return true;
}

describe("answerPermission", () => {
  test("moves to the choice the terminal shows and confirms it", async () => {
    const tui = new FakeTui(screen("03-permission-bash"), (key, self) => {
      if (arrows(key, self, 4)) return;
      if (key === "\r") self.lines = screen("02-idle");
    });
    await answerPermission(tui, "always");
    expect(tui.keys).toEqual(["\x1b[B", "\r"]);
  });

  test("a refusal with feedback sends the feedback as the next prompt", async () => {
    const tui = new FakeTui(screen("03-permission-bash"), (key, self) => {
      if (arrows(key, self, 4)) return;
      if (key === "\r") {
        self.lines = screen("02-idle");
        return;
      }
      if (key.startsWith("\x1b[200~")) {
        self.lines = self.lines.map((line) => (line.startsWith("❯") ? "❯ use node instead" : line));
      }
    });
    await answerPermission(tui, "deny", "use node instead");
    expect(tui.keys).toEqual([
      "\x1b[B",
      "\x1b[B",
      "\x1b[B",
      "\r",
      "\x1b[200~use node instead\x1b[201~",
      "\r",
    ]);
  });

  test("finds the always-allow choice whichever way the terminal words it", async () => {
    const lines = screen("03-permission-bash").map((line) =>
      line.replace(
        /Yes, and don.t ask again for: python3 \*/u,
        "Yes, and always allow access to src/ from this project",
      ),
    );
    const tui = new FakeTui(lines, (key, self) => {
      if (arrows(key, self, 4)) return;
      if (key === "\r") self.lines = screen("02-idle");
    });
    await answerPermission(tui, "always");
    expect(tui.keys).toEqual(["\x1b[B", "\r"]);
  });

  test("types nothing when the dialog lacks the choice", async () => {
    const lines = screen("03-permission-bash").filter((line) => !/don.t ask again/u.test(line));
    const tui = new FakeTui(lines, () => {});
    await expect(answerPermission(tui, "always")).rejects.toBeInstanceOf(FallbackError);
    expect(tui.keys).toEqual([]);
  });
});

describe("submitPrompt", () => {
  test("pastes the prompt and submits it", async () => {
    const tui = new FakeTui(screen("02-idle"), (key, self) => {
      if (key.startsWith("\x1b[200~")) {
        self.lines = self.lines.map((line) => (line.startsWith("❯") ? "❯ hello" : line));
      }
    });
    await submitPrompt(tui, "hello\r\nworld");
    expect(tui.keys).toEqual(["\x1b[200~hello\nworld\x1b[201~", "\r"]);
  });

  test("refuses over a dialog, a draft in the terminal, and escape sequences", async () => {
    const dialog = new FakeTui(screen("03-permission-bash"), () => {});
    await expect(submitPrompt(dialog, "hi")).rejects.toThrow(/dialog/u);
    const draft = new FakeTui(
      screen("02-idle").map((line) => (line.startsWith("❯") ? "❯ half" : line)),
      () => {},
    );
    await expect(submitPrompt(draft, "hi")).rejects.toThrow(/unsent input/u);
    const idle = new FakeTui(screen("02-idle"), () => {});
    await expect(submitPrompt(idle, "hi\x1b[201~\r/exit")).rejects.toThrow(/control characters/u);
    expect([...dialog.keys, ...draft.keys, ...idle.keys]).toEqual([]);
  });
});

describe("answerQuestions", () => {
  const questions: AgentQuestion[] = [
    {
      question: "Which color do you prefer?",
      header: "Color",
      options: [
        { label: "Red", description: "Choose red" },
        { label: "Blue", description: "Choose blue" },
      ],
      multiSelect: false,
    },
    {
      question: "Which fruits do you like?",
      header: "Fruit",
      options: [
        { label: "Apple", description: "Choose apple" },
        { label: "Pear", description: "Choose pear" },
        { label: "Plum", description: "Choose plum" },
      ],
      multiSelect: true,
    },
  ];

  test("answers each page, toggles checkboxes to match, and submits on the review page", async () => {
    let page = 1;
    const tui = new FakeTui(screen("05-question-1"), (key, self) => {
      if (arrows(key, self, page === 1 ? 4 : page === 2 ? 5 : 2)) return;
      if (page === 1 && key === "\r") {
        page = 2;
        self.lines = screen("06-question-2-multi");
      } else if (page === 2 && key === " ") {
        const cursor = cursorOf(self.lines);
        self.lines = self.lines.map((line) =>
          line.includes(`${cursor}. [`)
            ? line.replace(/\[( |✔)\]/u, (_m, mark: string) => (mark === " " ? "[✔]" : "[ ]"))
            : line,
        );
      } else if (page === 2 && key === "\t") {
        page = 3;
        self.lines = screen("08-question-submit");
      } else if (page === 3 && key === "\r") {
        self.lines = screen("02-idle");
      }
    });
    await answerQuestions(tui, questions, [{ labels: ["Blue"] }, { labels: ["Apple", "Plum"] }]);
    expect(tui.keys).toEqual(["\x1b[B", "\r", " ", "\x1b[B", "\x1b[B", " ", "\t", "\r"]);
  });
});

describe("answerQuestions with one question", () => {
  test("chooses the answer; there is no review page to submit", async () => {
    const tui = new FakeTui(screen("05a-question-single"), (key, self) => {
      if (key === "\x1b[B") self.lines = screen("05b-question-single-moved");
      else if (key === "\r") self.lines = screen("02-idle");
    });
    const question: AgentQuestion = {
      question: "Which size do you want?",
      header: "Size",
      options: [
        { label: "Small", description: "" },
        { label: "Large", description: "" },
      ],
      multiSelect: false,
    };
    await answerQuestions(tui, [question], [{ labels: ["Large"] }]);
    expect(tui.keys).toEqual(["\x1b[B", "\r"]);
  });
});

describe("setPermissionMode", () => {
  test("cycles Shift+Tab until the footer shows the mode", async () => {
    // Claude Code's cycle as recorded: manual, accept edits, plan, auto.
    const cycle = ["10-mode-3", "10-mode-0", "10-mode-1", "10-mode-2"];
    let at = 0;
    const tui = new FakeTui(screen(cycle[0]!), (key, self) => {
      if (key !== "\x1b[Z") return;
      at = (at + 1) % cycle.length;
      self.lines = screen(cycle[at]!);
    });
    await setPermissionMode(tui, "plan");
    expect(tui.keys).toEqual(["\x1b[Z", "\x1b[Z"]);
    await expect(setPermissionMode(tui, "bypassPermissions")).rejects.toThrow(
      /not one of the modes/u,
    );
  });
});

describe("answerPlan", () => {
  test("approves with the chosen mode, or revises with feedback typed into the plan dialog", async () => {
    const approve = new FakeTui(screen("11-plan-approval"), (key, self) => {
      if (arrows(key, self, 3)) return;
      if (key === "\r") self.lines = screen("02-idle");
    });
    await answerPlan(approve, "approve-manual");
    expect(approve.keys).toEqual(["\x1b[B", "\r"]);

    const revise = new FakeTui(screen("11-plan-approval"), (key, self) => {
      if (arrows(key, self, 3)) return;
      if (key === "\r") self.lines = screen("12-after-plan-escape");
    });
    await answerPlan(revise, "revise", "use printf");
    expect(revise.keys).toEqual(["\x1b[B", "\x1b[B", "\x1b[200~use printf\x1b[201~", "\r"]);
  });
});
