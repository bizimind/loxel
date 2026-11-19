/**
 * Plumbing shared by the hooks that take what the Electron main process sends a window about its
 * webviews' pages (dialogs, permission requests, notifications) to the browser panel whose
 * `<webview>` the page is in, and that keep main's copy of the settings it decides from.
 */
import { useCallback, useMemo, useState } from "react";

import { type SettingsState, useSettingsStore } from "@/store/settings-store";

export interface WebviewRouter<Listener, Item> {
  /** Hand `item` to the panel of webview `webContentsId`, or hold it until that panel subscribes. */
  deliver: (webContentsId: number, item: Item) => void;
  /**
   * Drop the held items of webview `webContentsId` that `drop` matches, and return its panel's
   * listener, when one has subscribed, to withdraw what it already got.
   */
  withdraw: (webContentsId: number, drop: (item: Item) => boolean) => Listener | undefined;
  /** Subscribe the panel of webview `webContentsId`, handing it what was held for it. */
  subscribe: (webContentsId: number, listener: Listener) => () => void;
}

/**
 * Routes a window's messages to browser panels by the guest webContents id of their webview.
 * What arrives for a webview whose panel hasn't subscribed yet (a page can ask while loading,
 * before the panel knows its webContents id) is held, at most `maxHeld` items per webview when a
 * webview no panel claims must not grow it.
 */
export function createWebviewRouter<Listener, Item>(
  dispatch: (listener: Listener, item: Item) => void,
  maxHeld = Number.POSITIVE_INFINITY,
): WebviewRouter<Listener, Item> {
  const listeners = new Map<number, Listener>();
  const unclaimed = new Map<number, Item[]>();
  return {
    deliver: (webContentsId, item) => {
      const listener = listeners.get(webContentsId);
      if (listener) return dispatch(listener, item);
      const held = [...(unclaimed.get(webContentsId) ?? []), item].slice(-maxHeld);
      unclaimed.set(webContentsId, held);
    },
    withdraw: (webContentsId, drop) => {
      const waiting = unclaimed.get(webContentsId)?.filter((item) => !drop(item));
      if (waiting?.length) unclaimed.set(webContentsId, waiting);
      else unclaimed.delete(webContentsId);
      return listeners.get(webContentsId);
    },
    subscribe: (webContentsId, listener) => {
      listeners.set(webContentsId, listener);
      const held = unclaimed.get(webContentsId) ?? [];
      unclaimed.delete(webContentsId);
      for (const item of held) dispatch(listener, item);
      return () => {
        if (listeners.get(webContentsId) === listener) listeners.delete(webContentsId);
      };
    },
  };
}

/** A request main sends about the page of webview `webContentsId`, answered by `id`. */
interface WebviewRequest {
  id: number;
  webContentsId: number;
}

/**
 * A browser panel's queue of open requests from main, oldest first, for the webview with this
 * guest webContents id (null until it is ready). `add` drops the requests of an earlier guest (the
 * webview was re-created).
 */
export function useWebviewRequests<T extends WebviewRequest>(
  webContentsId: number | null,
): { requests: T[]; add: (request: T) => void; remove: (id: number) => void; clear: () => void } {
  const [queue, setQueue] = useState<T[]>([]);
  const add = useCallback(
    (request: T) =>
      setQueue((prev) => [...prev.filter((r) => r.webContentsId === webContentsId), request]),
    [webContentsId],
  );
  const remove = useCallback(
    (id: number) => setQueue((prev) => prev.filter((request) => request.id !== id)),
    [],
  );
  const clear = useCallback(() => setQueue([]), []);
  const requests = useMemo(
    () => queue.filter((request) => request.webContentsId === webContentsId),
    [queue, webContentsId],
  );
  return { requests, add, remove, clear };
}

/**
 * Send main the setting `select` picks now and whenever it changes (by `isEqual`), with `push`.
 * Not before hydration: main would take the defaults for the user's decisions.
 */
export function syncSettingToMain<T>(
  select: (state: SettingsState) => T,
  push: (value: T) => void,
  isEqual: (a: T, b: T) => boolean = Object.is,
): void {
  const send = () => push(select(useSettingsStore.getState()));
  if (useSettingsStore.persist.hasHydrated()) send();
  else useSettingsStore.persist.onFinishHydration(send);
  useSettingsStore.subscribe((state, previous) => {
    if (!isEqual(select(state), select(previous))) send();
  });
}
