import { describe, expect, test } from "bun:test";

import { WorktreeHistory } from "./worktree-history";

const always = () => true;

describe("WorktreeHistory", () => {
  test("goes back and forward like a browser", () => {
    const history = new WorktreeHistory();
    // A → B → C
    history.record("A");
    history.record("B");
    expect(history.goBack("C", always)).toBe("B");
    expect(history.goBack("B", always)).toBe("A");
    expect(history.goBack("A", always)).toBeNull();
    expect(history.goForward("A", always)).toBe("B");
    expect(history.goForward("B", always)).toBe("C");
    expect(history.goForward("C", always)).toBeNull();
  });

  test("a new navigation clears the forward stack", () => {
    const history = new WorktreeHistory();
    history.record("A");
    expect(history.goBack("B", always)).toBe("A");
    history.record("A"); // A → D
    expect(history.goForward("D", always)).toBeNull();
    expect(history.goBack("D", always)).toBe("A");
  });

  test("skips worktrees that no longer exist and the current one", () => {
    const history = new WorktreeHistory();
    history.record("A");
    history.record("gone");
    history.record("C");
    expect(history.goBack("C", (p) => p !== "gone")).toBe("A");
    expect(history.goForward("A", always)).toBe("C");
  });
});
