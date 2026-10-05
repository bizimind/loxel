import { afterEach, describe, expect, test } from "bun:test";

import { applyStoreUpdate } from "../store-sync";
import { normalizeKeyBinding, normalizeKeyCombo } from "./key-combo";
import { useKeybindingStore } from "./keybinding-store";
import {
  cancelPendingChord,
  hasPendingChord,
  resolveKeystroke,
  usePendingChordStore,
} from "./pending-chord";

const key = normalizeKeyCombo;

afterEach(() => {
  cancelPendingChord();
  useKeybindingStore.getState().resetAllOverrides();
});

describe("resolveKeystroke", () => {
  test("resolves a single-key binding", () => {
    expect(resolveKeystroke(key("Cmd+W"))).toEqual({ kind: "action", actionId: "panel.close" });
    expect(hasPendingChord()).toBe(false);
  });

  test("leaves unbound and tree-local keys alone", () => {
    expect(resolveKeystroke(key("Cmd+Shift+Y"))).toEqual({ kind: "unbound" });
    expect(resolveKeystroke(key("ArrowDown"))).toEqual({ kind: "unbound" });
  });

  test("resolves a two-step chord", () => {
    expect(resolveKeystroke(key("Cmd+Backslash"))).toEqual({ kind: "pending" });
    expect(usePendingChordStore.getState().steps).toEqual([key("Cmd+Backslash")]);
    expect(resolveKeystroke(key("ArrowRight"))).toEqual({
      kind: "action",
      actionId: "panel.split.right",
    });
    expect(hasPendingChord()).toBe(false);
  });

  test("resolves a three-step typed split chord", () => {
    resolveKeystroke(key("Cmd+Backslash"));
    expect(resolveKeystroke(key("T"))).toEqual({ kind: "pending" });
    expect(resolveKeystroke(key("ArrowDown"))).toEqual({
      kind: "action",
      actionId: "panel.split.terminal.down",
    });
  });

  test("accepts later steps typed with ⌘ still held", () => {
    resolveKeystroke(key("Cmd+Backslash"));
    expect(resolveKeystroke(key("Cmd+Shift+ArrowLeft"))).toEqual({
      kind: "action",
      actionId: "panel.move.newLeft",
    });
  });

  test("⌘ is only ignored on later steps after a ⌘ leader", () => {
    useKeybindingStore.getState().setOverride("app.settings", [normalizeKeyBinding("Ctrl+K W")]);
    resolveKeystroke(key("Ctrl+K"));
    expect(resolveKeystroke(key("Cmd+W"))).toEqual({ kind: "cancelled" });
    resolveKeystroke(key("Ctrl+K"));
    expect(resolveKeystroke(key("W"))).toEqual({ kind: "action", actionId: "app.settings" });
  });

  test("an unmatched key or Escape cancels the chord and is swallowed", () => {
    resolveKeystroke(key("Cmd+Backslash"));
    expect(resolveKeystroke(key("Q"))).toEqual({ kind: "cancelled" });
    expect(hasPendingChord()).toBe(false);

    resolveKeystroke(key("Cmd+Backslash"));
    expect(resolveKeystroke(key("Escape"))).toEqual({ kind: "cancelled" });
    // A key that is bound on its own does not run while it cancels a chord.
    resolveKeystroke(key("Cmd+Backslash"));
    expect(resolveKeystroke(key("Cmd+W"))).toEqual({ kind: "cancelled" });
  });

  test("a user-bound single key wins over a chord with the same first key", () => {
    useKeybindingStore.getState().setOverride("app.settings", [key("Cmd+Backslash")]);
    expect(resolveKeystroke(key("Cmd+Backslash"))).toEqual({
      kind: "action",
      actionId: "app.settings",
    });
  });
});

describe("Enter-ended chords", () => {
  test("⌘\\ then a type letter then Enter opens that panel type as a tab", () => {
    resolveKeystroke(key("Cmd+Backslash"));
    resolveKeystroke(key("B"));
    expect(resolveKeystroke(key("Enter"))).toEqual({
      kind: "action",
      actionId: "panel.new.browser",
    });
  });

  test("⌘\\ then Enter opens a tab of the active panel's type", () => {
    resolveKeystroke(key("Cmd+Backslash"));
    expect(resolveKeystroke(key("Enter"))).toEqual({ kind: "action", actionId: "panel.newTab" });
  });
});

describe("context-dependent actions", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  function focusIn(area: string): void {
    const container = document.createElement("div");
    container.setAttribute("data-focus-area", area);
    const button = document.createElement("button");
    container.append(button);
    document.body.append(container);
    button.focus();
  }

  test("⌃⇧Space passes through while focus is in the center", () => {
    focusIn("center");
    expect(resolveKeystroke(key("Ctrl+Shift+Space"))).toEqual({ kind: "unbound" });
  });

  test("⌃⇧Space toggles while focus is in the worktree sidebar", () => {
    focusIn("worktrees");
    expect(resolveKeystroke(key("Ctrl+Shift+Space"))).toEqual({
      kind: "action",
      actionId: "sidebar.toggleFocused",
    });
  });
});

describe("setOverride", () => {
  test("binding a chord prefix removes the chords it shadows from other actions", () => {
    useKeybindingStore.getState().setOverride("app.settings", [key("Cmd+Backslash")]);
    const { overrides } = useKeybindingStore.getState();
    expect(overrides["panel.split.right"]).toEqual([]);
    expect(overrides["panel.split.terminal.right"]).toEqual([]);
  });
});

describe("cross-window sync", () => {
  test("a synced override re-derives chord prefixes", () => {
    // Another window binds the ⌘\ leader on its own, which strips every ⌘\ chord.
    useKeybindingStore.getState().setOverride("app.settings", [key("Cmd+Backslash")]);
    const remote = useKeybindingStore.getState().overrides;
    useKeybindingStore.getState().resetAllOverrides();
    expect(resolveKeystroke(key("Cmd+Backslash"))).toEqual({ kind: "pending" });
    cancelPendingChord();

    applyStoreUpdate("keybindings", { activeTemplate: "loxel", overrides: remote });
    expect(resolveKeystroke(key("Cmd+Backslash"))).toEqual({
      kind: "action",
      actionId: "app.settings",
    });
    expect(
      useKeybindingStore.getState().chordPrefixes.has(normalizeKeyBinding("Cmd+Backslash")),
    ).toBe(false);
  });
});
