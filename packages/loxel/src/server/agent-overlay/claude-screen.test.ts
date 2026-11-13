import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  effortFromScreen,
  permissionModeFromScreen,
  promptBoxState,
  recognizeDialog,
} from "./claude-screen";

/** A screen recorded from Claude Code 2.1.325 with scripts/capture-claude-tui.ts. */
function screen(name: string): string[] {
  return readFileSync(join(import.meta.dir, "fixtures", "claude-2.1.325", `${name}.txt`), "utf8")
    .replace(/\n$/u, "")
    .split("\n");
}

const labels = (name: string) => recognizeDialog(screen(name))?.options.map((o) => o.label);

describe("recognizeDialog", () => {
  test("a Bash permission prompt, with the choices as the terminal words them", () => {
    const dialog = recognizeDialog(screen("03-permission-bash"));
    expect(dialog?.kind).toBe("permission");
    expect(
      dialog?.options.map(({ number, label, selected }) => ({ number, label, selected })),
    ).toEqual([
      { number: 1, label: "Yes", selected: true },
      { number: 2, label: "Yes, and don’t ask again for: python3 *", selected: false },
      {
        number: 3,
        label: "Yes, and switch to auto mode · auto mode handles these prompts for you",
        selected: false,
      },
      { number: 4, label: "No", selected: false },
    ]);
  });

  test("AskUserQuestion pages: the question, its options, checkboxes and the cursor", () => {
    const single = recognizeDialog(screen("05-question-1"));
    expect(single?.kind).toBe("question");
    expect(single?.prompt).toBe("Which color do you prefer?");
    expect(single?.options.map((o) => o.label)).toEqual([
      "Red",
      "Blue",
      "Type something.",
      "Chat about this",
    ]);
    expect(single?.options.every((o) => o.checked === null)).toBe(true);

    const toggled = recognizeDialog(screen("07-question-2-toggled"));
    expect(toggled?.prompt).toBe("Which fruits do you like?");
    expect(
      toggled?.options.map(({ label, checked, selected }) => ({ label, checked, selected })),
    ).toEqual([
      { label: "Apple", checked: true, selected: false },
      { label: "Pear", checked: false, selected: false },
      { label: "Plum", checked: true, selected: true },
      { label: "Type something", checked: false, selected: false },
      { label: "Chat about this", checked: null, selected: false },
    ]);
  });

  test("a single question, whose tab bar has no arrows", () => {
    const single = recognizeDialog(screen("05a-question-single"));
    expect(single?.kind).toBe("question");
    expect(single?.prompt).toBe("Which size do you want?");
    expect(single?.options.map((o) => o.label)).toEqual([
      "Small",
      "Large",
      "Type something.",
      "Chat about this",
    ]);
  });

  test("the plan's feedback choice, selected and with feedback typed into it", () => {
    const selected = recognizeDialog(screen("11b-plan-revise-selected"));
    expect(selected?.options.find((o) => o.selected)?.label).toBe("Tell Claude what to change");
    const typed = recognizeDialog(screen("11c-plan-revise-typed"));
    expect(typed?.kind).toBe("plan");
    expect(typed?.options.find((o) => o.selected)?.label).toBe("Use printf in Bash instead.");
  });

  test("the answers review page and the plan approval", () => {
    expect(recognizeDialog(screen("08-question-submit"))?.kind).toBe("question-review");
    expect(labels("08-question-submit")).toEqual(["Submit answers", "Cancel"]);

    const plan = recognizeDialog(screen("11-plan-approval"));
    expect(plan?.kind).toBe("plan");
    // The plan's own numbered steps are not choices.
    expect(plan?.options.map((o) => o.label)).toEqual([
      "Yes, and use auto mode",
      "Yes, manually approve edits",
      "Tell Claude what to change",
    ]);
  });

  test("nothing for the input box, a plan rejected back to it, or a dialog it does not know", () => {
    expect(recognizeDialog(screen("02-idle"))).toBeNull();
    expect(recognizeDialog(screen("12-after-plan-escape"))).toBeNull();
    // The workspace trust prompt has unnumbered choices, defaulting to "No, exit".
    expect(recognizeDialog(screen("01-trust-dialog"))).toBeNull();
  });
});

describe("input box and footer", () => {
  test("the input box is empty when idle, absent while a dialog replaces it", () => {
    expect(promptBoxState(screen("02-idle"))).toBe("empty");
    expect(promptBoxState(screen("03-permission-bash"))).toBe("absent");
    const draft = screen("02-idle").map((line) => (line.startsWith("❯") ? "❯ half-typed" : line));
    expect(promptBoxState(draft)).toBe("draft");
  });

  test("the permission mode the footer shows, with manual as default", () => {
    expect(permissionModeFromScreen(screen("10-mode-0"))).toBe("acceptEdits");
    expect(permissionModeFromScreen(screen("10-mode-1"))).toBe("plan");
    expect(permissionModeFromScreen(screen("10-mode-2"))).toBe("auto");
    expect(permissionModeFromScreen(screen("10-mode-3"))).toBe("default");
    expect(permissionModeFromScreen(screen("05-question-1"))).toBeNull();
  });

  test("the effort level the footer shows", () => {
    expect(effortFromScreen(screen("02-idle"))).toBe("medium");
    expect(effortFromScreen(screen("05-question-1"))).toBeNull();
  });
});
