import { describe, expect, test } from "bun:test";

import { getCenterPanelDefByType } from "../panel-config";
import { SPLIT_PANEL_TYPES } from "./action-registry";
import type { KeyBinding } from "./key-combo";
import {
  bindingsOverlap,
  eventToKeyCombo,
  getBindingSteps,
  inputToKeyCombo,
  normalizeKeyBinding,
  normalizeKeyCombo,
} from "./key-combo";
import { buildChordPrefixes, buildReverseLookup } from "./keybinding-resolver";
import type { BindingTemplate } from "./keybinding-schema";
import { TEMPLATES, validateBindings, validateCoverage } from "./keybinding-schema";

// ---------------------------------------------------------------------------
// Template validation
// ---------------------------------------------------------------------------

describe("template conflict detection", () => {
  for (const [name, template] of Object.entries(TEMPLATES)) {
    test(`${name} template has no duplicate or chord-prefix conflicts`, () => {
      // validateBindings throws on duplicates and on a binding that prefixes a chord
      expect(() => validateBindings(template)).not.toThrow();
    });

    test(`${name} template covers all actions`, () => {
      const missing = validateCoverage(template);
      expect(missing).toEqual([]);
    });
  }
});

describe("validateBindings", () => {
  const template = (raw: Record<string, string[]>) =>
    Object.fromEntries(
      Object.entries(raw).map(([id, bindings]) => [id, bindings.map(normalizeKeyBinding)]),
    ) as unknown as BindingTemplate;

  test("rejects the same binding on two actions", () => {
    expect(() => validateBindings(template({ a: ["Cmd+N"], b: ["Cmd+N"] }))).toThrow();
  });

  test("rejects a single key that is the first step of a chord", () => {
    expect(() =>
      validateBindings(template({ a: ["Cmd+Backslash"], b: ["Cmd+Backslash ArrowRight"] })),
    ).toThrow();
  });

  test("allows chords that share a prefix", () => {
    expect(() =>
      validateBindings(
        template({ a: ["Cmd+Backslash ArrowRight"], b: ["Cmd+Backslash T ArrowRight"] }),
      ),
    ).not.toThrow();
  });
});

describe("split panel types", () => {
  test("every split type is a non-singleton center panel", () => {
    for (const { type } of SPLIT_PANEL_TYPES) {
      const def = getCenterPanelDefByType(type);
      expect(def).toBeDefined();
      expect(def?.singleton).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// normalizeKeyCombo / normalizeKeyBinding
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

describe("normalizeKeyBinding", () => {
  test("normalizes every chord step", () => {
    expect(normalizeKeyBinding("Meta+\\  shift+ArrowRight") as string).toBe(
      "Cmd+Backslash Shift+ArrowRight",
    );
    expect(getBindingSteps(normalizeKeyBinding("Cmd+\\ t ArrowUp"))).toEqual([
      normalizeKeyCombo("Cmd+Backslash"),
      normalizeKeyCombo("T"),
      normalizeKeyCombo("ArrowUp"),
    ]);
  });

  test("bindingsOverlap detects equality and chord prefixes only", () => {
    const leader = normalizeKeyBinding("Cmd+Backslash");
    const chord = normalizeKeyBinding("Cmd+Backslash ArrowRight");
    expect(bindingsOverlap(leader, chord)).toBe(true);
    expect(bindingsOverlap(chord, leader)).toBe(true);
    expect(bindingsOverlap(chord, chord)).toBe(true);
    expect(bindingsOverlap(chord, normalizeKeyBinding("Cmd+Backslash ArrowLeft"))).toBe(false);
    expect(
      bindingsOverlap(normalizeKeyBinding("Cmd+B"), normalizeKeyBinding("Cmd+Backslash")),
    ).toBe(false);
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

  test("uses the physical key while Option is held (macOS composes the character)", () => {
    const opt = { ctrlKey: true, altKey: true };
    expect(eventToKeyCombo(makeEvent({ ...opt, key: "˜", code: "KeyN" })) as string).toBe(
      "Ctrl+Alt+N",
    );
    expect(eventToKeyCombo(makeEvent({ ...opt, key: "“", code: "BracketLeft" })) as string).toBe(
      "Ctrl+Alt+BracketLeft",
    );
    expect(eventToKeyCombo(makeEvent({ ...opt, key: "¡", code: "Digit1" })) as string).toBe(
      "Ctrl+Alt+1",
    );
    expect(eventToKeyCombo(makeEvent({ ...opt, key: "ArrowUp", code: "ArrowUp" })) as string).toBe(
      "Ctrl+Alt+ArrowUp",
    );
  });

  test("keeps the typed character when Option doesn't compose one (non-QWERTY layouts)", () => {
    // Dvorak: the key typing "b" sits where QWERTY has N.
    const combo = eventToKeyCombo(
      makeEvent({ ctrlKey: true, altKey: true, key: "b", code: "KeyN" }),
    );
    expect(combo as string).toBe("Ctrl+Alt+B");
  });

  test("inputToKeyCombo matches eventToKeyCombo for Electron input", () => {
    const combo = inputToKeyCombo({
      key: "∫",
      code: "KeyB",
      meta: false,
      control: true,
      alt: true,
      shift: false,
    });
    expect(combo as string).toBe("Ctrl+Alt+B");
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
      Record<string, readonly KeyBinding[]>
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

describe("buildChordPrefixes", () => {
  test("collects every strict prefix of the bound chords", () => {
    const prefixes = buildChordPrefixes(buildReverseLookup(TEMPLATES.loxel, {}));
    expect(prefixes.has(normalizeKeyBinding("Cmd+Backslash"))).toBe(true);
    expect(prefixes.has(normalizeKeyBinding("Cmd+Backslash T"))).toBe(true);
    expect(prefixes.has(normalizeKeyBinding("Cmd+Backslash T ArrowRight"))).toBe(false);
    expect(prefixes.has(normalizeKeyBinding("Cmd+N"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cross-check: keys deliberately left to Monaco and window managers
// ---------------------------------------------------------------------------

describe("no default binding takes reserved keys", () => {
  const RESERVED: Record<string, string> = {
    "Cmd+Shift+O": "Monaco: Go to Symbol",
    "Cmd+Shift+Backslash": "Monaco: Jump to Bracket",
    "Ctrl+Cmd+Shift+ArrowLeft": "Monaco: Shrink Selection",
    "Ctrl+Cmd+Shift+ArrowRight": "Monaco: Expand Selection",
    "Ctrl+Alt+ArrowLeft": "Monaco: word-part left / Rectangle: left half",
    "Ctrl+Alt+ArrowRight": "Monaco: word-part right / Rectangle: right half",
    "Ctrl+Alt+ArrowUp": "Rectangle: top half",
    "Ctrl+Alt+ArrowDown": "Rectangle: bottom half",
    "Ctrl+Alt+Backspace": "Rectangle: Restore",
  };

  for (const [name, template] of Object.entries(TEMPLATES)) {
    test(`${name} template leaves reserved keys alone`, () => {
      const firstSteps = new Set(
        Object.values(template)
          .flat()
          .map((binding) => getBindingSteps(binding)[0]! as string),
      );
      expect(Object.keys(RESERVED).filter((combo) => firstSteps.has(combo))).toEqual([]);
    });
  }
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
      // A chord's first keystroke is intercepted too, so check those as well.
      const firstSteps = Object.values(template)
        .flat()
        .map((binding) => getBindingSteps(binding)[0]!);
      const conflicts = firstSteps.filter((combo) => SYSTEM_SHORTCUTS.includes(combo));
      expect(conflicts).toEqual([]);
    });
  }
});
