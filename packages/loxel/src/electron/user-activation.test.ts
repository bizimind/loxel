import { describe, expect, test } from "bun:test";

import type { WebContents } from "electron";

import { USER_ACTIVATION_MS, trackUserActivation, userActivationOf } from "./user-activation";

type Listener = (...args: unknown[]) => void;

/** A page's webContents whose clicks and key presses the test sends, on a clock it moves. */
function fakePage() {
  const listeners = new Map<string, Listener[]>();
  const clock = { time: 1_000 };
  const contents = {
    on: (name: string, fn: Listener) => listeners.set(name, [...(listeners.get(name) ?? []), fn]),
  } as unknown as WebContents;
  const emit = (name: string, input: unknown) => {
    for (const fn of listeners.get(name) ?? []) fn({}, input);
  };
  const activation = trackUserActivation(contents, () => clock.time);
  return {
    contents,
    activation,
    clock,
    click: () => emit("before-mouse-event", { type: "mouseDown" }),
    press: (key: string, isAutoRepeat = false) =>
      emit("before-input-event", { type: "keyDown", key, isAutoRepeat }),
  };
}

describe("trackUserActivation", () => {
  test("a click or key press counts for USER_ACTIVATION_MS", () => {
    const page = fakePage();
    expect(page.activation.isActive()).toBe(false);
    page.click();
    page.clock.time += USER_ACTIVATION_MS - 1;
    expect(page.activation.isActive()).toBe(true);
    page.clock.time += 1;
    expect(page.activation.isActive()).toBe(false);
    page.press("Enter");
    expect(page.activation.isActive()).toBe(true);
  });

  test("modifier keys and key repeats are no activation", () => {
    const page = fakePage();
    page.press("Meta");
    page.press("a", true);
    expect(page.activation.isActive()).toBe(false);
  });

  test("consuming it makes the next action need another click", () => {
    const page = fakePage();
    page.click();
    page.activation.consume();
    expect(page.activation.isActive()).toBe(false);
    page.click();
    expect(page.activation.isActive()).toBe(true);
  });

  test("one tracker per webContents, shared by everything that checks it", () => {
    const page = fakePage();
    expect(trackUserActivation(page.contents)).toBe(page.activation);
    expect(userActivationOf(page.contents)).toBe(page.activation);
    expect(userActivationOf({} as WebContents)).toBeNull();
  });
});
