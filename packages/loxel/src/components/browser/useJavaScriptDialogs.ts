/**
 * Routes `alert()` / `confirm()` / `prompt()` from browser panel pages, which the Electron main
 * process sends to the window (see `src/electron/javascript-dialogs.ts`), to the panel whose
 * `<webview>` the page is in.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  type JavaScriptDialogRequest,
  type JavaScriptDialogResponse,
  javaScriptDialogClosedSchema,
  javaScriptDialogRequestSchema,
} from "@/electron/javascript-dialog-protocol";
import { frontendLog } from "@/lib/frontend-logger";

const log = frontendLog.child("ui");

interface DialogListener {
  open: (request: JavaScriptDialogRequest) => void;
  close: (id: number) => void;
}

/** Browser panels by the guest webContents id of their webview. */
const listeners = new Map<number, DialogListener>();
/**
 * Requests for a webview whose panel hasn't subscribed yet (a page can open one while loading,
 * before the panel knows its webContents id). Main withdraws them if the page goes away.
 */
const unclaimed = new Map<number, JavaScriptDialogRequest[]>();
let listening = false;

export type JavaScriptDialogAnswer = Omit<JavaScriptDialogResponse, "id">;

function handleOpen(value: unknown): void {
  const parsed = javaScriptDialogRequestSchema.safeParse(value);
  if (!parsed.success) {
    log.warn("Ignoring malformed JavaScript dialog request", { error: parsed.error.message });
    return;
  }
  const request = parsed.data;
  const listener = listeners.get(request.webContentsId);
  if (listener) {
    listener.open(request);
    return;
  }
  unclaimed.set(request.webContentsId, [...(unclaimed.get(request.webContentsId) ?? []), request]);
}

function handleClosed(value: unknown): void {
  const parsed = javaScriptDialogClosedSchema.safeParse(value);
  if (!parsed.success) return;
  const { id, webContentsId } = parsed.data;
  listeners.get(webContentsId)?.close(id);
  const waiting = unclaimed.get(webContentsId)?.filter((request) => request.id !== id);
  if (waiting?.length) unclaimed.set(webContentsId, waiting);
  else unclaimed.delete(webContentsId);
}

/**
 * One window-wide subscription, kept for the window's lifetime and started when the first browser
 * panel mounts, before its webview loads a page. Bundles that predate dialogs have no
 * onJavaScriptDialog; their pages keep Electron's behavior.
 */
function listen(): void {
  if (listening) return;
  listening = true;
  window.electronAPI?.onJavaScriptDialog?.(handleOpen, handleClosed);
}

function subscribe(webContentsId: number, listener: DialogListener): () => void {
  listeners.set(webContentsId, listener);
  for (const request of unclaimed.get(webContentsId) ?? []) listener.open(request);
  unclaimed.delete(webContentsId);
  return () => {
    if (listeners.get(webContentsId) === listener) listeners.delete(webContentsId);
  };
}

const dismissed: JavaScriptDialogAnswer = { accepted: false, value: "", suppress: false };

/**
 * The page dialogs of the webview with this guest webContents id (null until it is ready),
 * oldest first: `dialog` is the one to show, and `answer` replies to it and moves to the next.
 * `dismissAll` cancels every queued dialog, unblocking the page before the panel navigates it.
 */
export function useJavaScriptDialogs(webContentsId: number | null): {
  dialog: JavaScriptDialogRequest | null;
  answer: (answer: JavaScriptDialogAnswer) => void;
  dismissAll: () => void;
} {
  const [queue, setQueue] = useState<JavaScriptDialogRequest[]>([]);

  useEffect(() => {
    listen();
    if (webContentsId === null) return;
    return subscribe(webContentsId, {
      // A new guest (the webview was re-created) drops the old guest's dialogs.
      open: (request) =>
        setQueue((prev) => [...prev.filter((r) => r.webContentsId === webContentsId), request]),
      close: (id) => setQueue((prev) => prev.filter((request) => request.id !== id)),
    });
  }, [webContentsId]);

  const current = useMemo(
    () => queue.filter((request) => request.webContentsId === webContentsId),
    [queue, webContentsId],
  );
  const dialog = current[0] ?? null;
  const answer = useCallback(
    (reply: JavaScriptDialogAnswer) => {
      if (!dialog) return;
      window.electronAPI?.respondToJavaScriptDialog?.({ id: dialog.id, ...reply });
      setQueue((prev) => prev.filter((request) => request.id !== dialog.id));
    },
    [dialog],
  );
  const dismissAll = useCallback(() => {
    for (const request of current) {
      window.electronAPI?.respondToJavaScriptDialog?.({ id: request.id, ...dismissed });
    }
    if (current.length > 0) setQueue([]);
  }, [current]);

  return { dialog, answer, dismissAll };
}
