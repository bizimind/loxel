/**
 * Clicks and key presses in browser panel pages, their popups and Loxel's windows, as main sees
 * them: Chromium's transient user activation. What a page may only do right after the user acted
 * in it (open a tab, popup or window, launch another app) checks it here, and consumes it, so one
 * click can't open a flood of tabs, windows or apps.
 */
import type { WebContents } from "electron";

import { isModifierKey } from "../store/keybindings/key-combo";

/** How long a click or key press counts: Chromium's transient user activation. */
export const USER_ACTIVATION_MS = 5000;

export interface UserActivation {
  /** Whether the user clicked or pressed a key in the page within `USER_ACTIVATION_MS`. */
  isActive: () => boolean;
  /** Use up the activation: the next action needs another click or key press. */
  consume: () => void;
}

const tracked = new WeakMap<WebContents, UserActivation>();

/**
 * Track the user's clicks and key presses in `contents` (a webview, a popup it opened, or a Loxel
 * window), once per webContents; later calls return the same tracker.
 */
export function trackUserActivation(contents: WebContents, now = Date.now): UserActivation {
  const existing = tracked.get(contents);
  if (existing) return existing;
  let lastActivation = Number.NEGATIVE_INFINITY;
  contents.on("before-mouse-event", (_, input) => {
    if (input.type === "mouseDown") lastActivation = now();
  });
  contents.on("before-input-event", (_, input) => {
    if (input.type === "keyDown" && !input.isAutoRepeat && !isModifierKey(input.key)) {
      lastActivation = now();
    }
  });
  const activation: UserActivation = {
    isActive: () => now() - lastActivation < USER_ACTIVATION_MS,
    consume: () => {
      lastActivation = Number.NEGATIVE_INFINITY;
    },
  };
  tracked.set(contents, activation);
  return activation;
}

/** The tracker of `contents`, or null when its clicks aren't tracked. */
export function userActivationOf(contents: WebContents): UserActivation | null {
  return tracked.get(contents) ?? null;
}
