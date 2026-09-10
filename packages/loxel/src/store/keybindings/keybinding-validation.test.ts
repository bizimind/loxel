import { describe, expect, test } from "bun:test";

import { buildReverseLookup } from "./keybinding-resolver";
import type { KeyCombo } from "./keybinding-schema";
import {
  TEMPLATES,
  eventToKeyCombo,
  normalizeKeyCombo,
  validateBindings,
  validateCoverage,
} from "./keybinding-schema";

// ---------------------------------------------------------------------------
// Template validation
// ---------------------------------------------------------------------------

describe("template conflict detection", () => {
  for (const [name, template] of Object.entries(TEMPLATES)) {
    test(`${name} template has no duplicate key combos`, () => {
      // validateBindings throws on duplicates
      expect(() => validateBindings(template)).not.toThrow();
    });

    test(`${name} template covers all actions`, () => {
      const missing = validateCoverage(template);
      expect(missing).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// normalizeKeyCombo
// ---------------------------------------------------------------------------

describe("normalizeKeyCombo", () => {
  test("normalizes modifier order", () => {
    expect(normalizeKeyCombo("Shift+Cmd+N") as string).toBe("Cmd+Shift+N");
    expect(normalizeKeyCombo("Alt+Ctrl+Cmd+X") as string).toBe("Cmd+Ctrl+Alt+X");
  });

  test("normalizes Meta to Cmd", () => {
    expect(normalizeKeyCombo("Meta+N") as string).toBe("Cmd+N");
  });

  test("normalizes special key names", () => {
    expect(normalizeKeyCombo("Cmd+Shift+`") as string).toBe("Cmd+Shift+Backtick");
    expect(normalizeKeyCombo("Cmd+\\") as string).toBe("Cmd+Backslash");
    expect(normalizeKeyCombo("Cmd+[") as string).toBe("Cmd+BracketLeft");
    expect(normalizeKeyCombo("Cmd+]") as string).toBe("Cmd+BracketRight");
    expect(normalizeKeyCombo("Cmd+,") as string).toBe("Cmd+Comma");
  });

  test("preserves already-canonical names", () => {
    expect(normalizeKeyCombo("Cmd+Shift+Backtick") as string).toBe("Cmd+Shift+Backtick");
    expect(normalizeKeyCombo("Ctrl+Tab") as string).toBe("Ctrl+Tab");
  });
});

// ---------------------------------------------------------------------------
// eventToKeyCombo
// ---------------------------------------------------------------------------

describe("eventToKeyCombo", () => {
  function makeEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent {
    return {
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      key: "",
      ...overrides,
    } as KeyboardEvent;
  }

  test("produces canonical combo from keyboard event", () => {
    const combo = eventToKeyCombo(makeEvent({ metaKey: true, key: "n" }));
    expect(combo as string).toBe("Cmd+N");
  });

  test("eventToKeyCombo matches normalizeKeyCombo for letter keys", () => {
    const fromEvent = eventToKeyCombo(makeEvent({ metaKey: true, key: "n" }));
    const fromNormalize = normalizeKeyCombo("Cmd+N");
    expect(fromEvent).toBe(fromNormalize);
  });

  test("handles shifted special keys", () => {
    // When user presses Cmd+Shift+`, the browser reports key as "~"
    const combo = eventToKeyCombo(makeEvent({ metaKey: true, shiftKey: true, key: "~" }));
    expect(combo as string).toBe("Cmd+Shift+Backtick");
  });

  test("handles Ctrl+Tab", () => {
    const combo = eventToKeyCombo(makeEvent({ ctrlKey: true, key: "Tab" }));
    expect(combo as string).toBe("Ctrl+Tab");
  });

  test("handles Cmd+number with shift producing symbol", () => {
    // Cmd+Shift+1 might produce "!" on some keyboards
    const combo = eventToKeyCombo(makeEvent({ metaKey: true, shiftKey: true, key: "!" }));
    expect(combo as string).toBe("Cmd+Shift+1");
  });
});

// ---------------------------------------------------------------------------
// buildReverseLookup
// ---------------------------------------------------------------------------

describe("buildReverseLookup", () => {
  test("maps combos to action IDs", () => {
    const template = TEMPLATES.loxel;
    const lookup = buildReverseLookup(template, {});

    expect(lookup.get(normalizeKeyCombo("Cmd+N"))).toBe("panel.new.markdown");
    expect(lookup.get(normalizeKeyCombo("Cmd+W"))).toBe("panel.close");
    expect(lookup.get(normalizeKeyCombo("Cmd+Comma"))).toBe("app.settings");
  });

  test("user overrides replace template bindings", () => {
    const template = TEMPLATES.loxel;
    const overrides = { "panel.new.markdown": [normalizeKeyCombo("Cmd+Shift+N")] } as Partial<
      Record<string, readonly KeyCombo[]>
    >;

    const lookup = buildReverseLookup(template, overrides);

    // New binding works
    expect(lookup.get(normalizeKeyCombo("Cmd+Shift+N"))).toBe("panel.new.markdown");
    // Old binding no longer maps to this action
    expect(lookup.get(normalizeKeyCombo("Cmd+N"))).toBeUndefined();
  });

  test("handles multiple combos per action", () => {
    const template = TEMPLATES.loxel;
    const lookup = buildReverseLookup(template, {});

    // panel.next has two bindings
    expect(lookup.get(normalizeKeyCombo("Cmd+Shift+BracketRight"))).toBe("panel.next");
    expect(lookup.get(normalizeKeyCombo("Ctrl+Tab"))).toBe("panel.next");
  });
});

// ---------------------------------------------------------------------------
// Cross-check: no overlap with macOS system shortcuts
// ---------------------------------------------------------------------------

describe("no overlap with critical system shortcuts", () => {
  const SYSTEM_SHORTCUTS = [
    "Cmd+C",
    "Cmd+V",
    "Cmd+X",
    "Cmd+A",
    "Cmd+Z",
    "Cmd+Shift+Z",
    "Cmd+Q",
    "Cmd+H",
    "Cmd+M",
    "Cmd+S",
    "Cmd+F",
    "Cmd+Backtick",
  ].map(normalizeKeyCombo);

  for (const [name, template] of Object.entries(TEMPLATES)) {
    test(`${name} template does not bind system shortcuts`, () => {
      const allCombos = Object.values(template).flat();
      const conflicts = allCombos.filter((combo) => SYSTEM_SHORTCUTS.includes(combo));
      expect(conflicts).toEqual([]);
    });
  }
});
