/**
 * What browser panel permission prompts share in main: the open prompts, each shown as a bar in the
 * panel of the page that asked, and main's copy of the decisions saved in Loxel's settings.
 *
 * A prompt lives in the window hosting the page's webview: main sends that window a request under
 * a new id, the window answers by id, and main withdraws the request once it is answered some
 * other way or its page goes away. Each kind of prompt keeps what waits on its answer itself. While
 * a prompt is open, its page holds neither fullscreen nor the pointer lock (exclusive-access-holds.ts).
 */
import type { IpcMainEvent, WebContents } from "electron";

import { holdExclusiveAccess } from "./exclusive-access-holds";

/** A prompt shown in the browser panel of guest webContents `guestId`, which `host` hosts. */
export interface PanelPrompt {
  guestId: number;
  host: WebContents;
  /** The site asking. */
  origin: string;
}

export interface PermissionPrompts<P extends PanelPrompt> {
  /** Show `prompt` in its window under a new id, which it returns. */
  show: (prompt: P) => number;
  /**
   * Take down prompt `id` and tell its window; returns it, if it was open. Answering what waits on
   * it is the caller's.
   */
  withdraw: (id: number) => P | undefined;
  /**
   * Show `prompt` under a new id in place of `id`. What a prompt asks never changes under its id,
   * so an answer only ever covers what the user saw.
   */
  reprompt: (id: number, prompt: P) => number;
  /** The open prompts with their ids, oldest first, as a copy that withdrawing doesn't change. */
  entries: () => [number, P][];
  /** Open prompt `id`, if `event` comes from the window it was shown in. */
  answered: (event: IpcMainEvent, id: number) => P | undefined;
}

/**
 * Prompts that main sends on `channels.request` (as `message` builds them) and withdraws on
 * `channels.withdrawn`, with `{ id, webContentsId }`.
 */
export function createPermissionPrompts<P extends PanelPrompt>(
  channels: { request: string; withdrawn: string },
  message: (id: number, prompt: P) => unknown,
): PermissionPrompts<P> {
  const open = new Map<number, P>();
  /** Each open prompt's hold on its page's exclusive access. */
  const holds = new Map<number, () => void>();
  let nextId = 1;

  const show = (prompt: P): number => {
    const id = nextId++;
    open.set(id, prompt);
    holds.set(id, holdExclusiveAccess(prompt.guestId));
    prompt.host.send(channels.request, message(id, prompt));
    return id;
  };
  const withdraw = (id: number): P | undefined => {
    const prompt = open.get(id);
    if (!prompt) return undefined;
    open.delete(id);
    holds.get(id)?.();
    holds.delete(id);
    if (!prompt.host.isDestroyed()) {
      prompt.host.send(channels.withdrawn, { id, webContentsId: prompt.guestId });
    }
    return prompt;
  };
  return {
    show,
    withdraw,
    reprompt: (id, prompt) => {
      withdraw(id);
      return show(prompt);
    },
    entries: () => [...open],
    answered: (event, id) => {
      const prompt = open.get(id);
      return prompt?.host === event.sender ? prompt : undefined;
    },
  };
}

/**
 * Main's copy of decisions kept in Loxel's settings, which window renderers send on load and on
 * every change. Pages that ask before the first copy arrives wait for it (`loaded`), so they are
 * never answered from defaults that hide the user's decisions.
 */
export interface SettingsMirror<T> {
  get: () => T;
  /** The settings' copy, from a window. */
  receive: (value: T) => void;
  /**
   * A decision main applies at once, ahead of the window saving it in settings and sending it
   * back, so a page waiting on it doesn't wait for that round trip.
   */
  apply: (value: T) => void;
  isLoaded: () => boolean;
  /** Resolves once a window has sent the settings' copy. */
  loaded: Promise<void>;
}

export function createSettingsMirror<T>(initial: T): SettingsMirror<T> {
  let value = initial;
  let isLoaded = false;
  let resolveLoaded: () => void = () => {};
  const loaded = new Promise<void>((resolve) => {
    resolveLoaded = resolve;
  });
  return {
    get: () => value,
    receive: (next) => {
      value = next;
      if (isLoaded) return;
      isLoaded = true;
      resolveLoaded();
    },
    apply: (next) => {
      value = next;
    },
    isLoaded: () => isLoaded,
    loaded,
  };
}
