/**
 * Keep app keybindings working while a browser panel's `<webview>` has keyboard focus.
 *
 * Keys typed in a webview go to its guest process and never reach the window's document, where
 * the keybinding listener lives. Each window's renderer reports the keystrokes that start one of
 * its bindings — or that every keystroke should be captured while a chord is in progress. Those
 * keystrokes typed in a webview it hosts are withheld from the page and forwarded to the
 * renderer, which resolves them like a document keydown.
 */
import { type WebContents, ipcMain } from "electron";

import { inputToKeyCombo, isModifierKey } from "../store/keybindings/key-combo";
import { SET_KEYSTROKE_INTERCEPTION, WEBVIEW_KEYSTROKE } from "./ipc-channels";

interface Interception {
  combos: ReadonlySet<string>;
  captureAll: boolean;
}

/** Keystroke interception per host renderer (webContents id). */
const interceptionByHost = new Map<number, Interception>();

function parseInterception(value: unknown): Interception | null {
  if (typeof value !== "object" || value === null) return null;
  const { combos, captureAll } = value as Record<string, unknown>;
  if (!Array.isArray(combos) || !combos.every((c) => typeof c === "string")) return null;
  if (typeof captureAll !== "boolean") return null;
  return { combos: new Set(combos), captureAll };
}

export function installWebviewKeystrokeForwarding(): void {
  ipcMain.on(SET_KEYSTROKE_INTERCEPTION, (event, value: unknown) => {
    const interception = parseInterception(value);
    if (!interception) return;
    const host = event.sender;
    if (!interceptionByHost.has(host.id)) {
      host.once("destroyed", () => interceptionByHost.delete(host.id));
    }
    interceptionByHost.set(host.id, interception);
  });
}

/** Attach to every webview's webContents (from `web-contents-created`). */
export function forwardWebviewKeystrokes(contents: WebContents): void {
  if (contents.getType() !== "webview") return;
  contents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || input.isComposing || isModifierKey(input.key)) return;
    const host = contents.hostWebContents;
    if (!host || host.isDestroyed()) return;
    const interception = interceptionByHost.get(host.id);
    if (!interception) return;
    const combo = inputToKeyCombo(input);
    if (!interception.captureAll && !interception.combos.has(combo)) return;
    event.preventDefault();
    host.send(WEBVIEW_KEYSTROKE, combo, input.isAutoRepeat);
  });
}
