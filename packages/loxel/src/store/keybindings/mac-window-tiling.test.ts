import { describe, expect, test } from "bun:test";

import { normalizeKeyCombo } from "./key-combo";
import { isMacWindowTilingKeystroke } from "./mac-window-tiling";

const key = normalizeKeyCombo;

describe("isMacWindowTilingKeystroke", () => {
  test("matches the fn⌃ and fn⌃⇧ arrow shortcuts on macOS 15 and later", () => {
    for (const version of ["15.0.0", "26.5.0"]) {
      expect(isMacWindowTilingKeystroke(key("Ctrl+Home"), version)).toBe(true);
      expect(isMacWindowTilingKeystroke(key("Ctrl+End"), version)).toBe(true);
      expect(isMacWindowTilingKeystroke(key("Ctrl+PageUp"), version)).toBe(true);
      expect(isMacWindowTilingKeystroke(key("Ctrl+Shift+PageDown"), version)).toBe(true);
    }
  });

  test("leaves Ctrl+arrow, letter and other modifier combos to the app", () => {
    for (const combo of ["Ctrl+ArrowLeft", "Ctrl+Shift+ArrowUp", "Ctrl+F", "Ctrl+C", "Home"]) {
      expect(isMacWindowTilingKeystroke(key(combo), "15.0.0")).toBe(false);
    }
    expect(isMacWindowTilingKeystroke(key("Ctrl+Alt+Home"), "15.0.0")).toBe(false);
    expect(isMacWindowTilingKeystroke(key("Cmd+Ctrl+Home"), "15.0.0")).toBe(false);
  });

  test("matches nothing before macOS 15 or off macOS", () => {
    expect(isMacWindowTilingKeystroke(key("Ctrl+Home"), "14.6.1")).toBe(false);
    expect(isMacWindowTilingKeystroke(key("Ctrl+Home"), undefined)).toBe(false);
  });
});
