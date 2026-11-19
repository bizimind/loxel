/**
 * Routes `alert()` / `confirm()` / `prompt()` from browser panel pages, which the Electron main
 * process sends to the window (see `src/electron/javascript-dialogs.ts`), to the panel whose
 * `<webview>` the page is in.
 */
import { useCallback, useEffect } from "react";

import {
  type JavaScriptDialogRequest,
  type JavaScriptDialogResponse,
  javaScriptDialogClosedSchema,
  javaScriptDialogRequestSchema,
} from "@/electron/javascript-dialog-protocol";
import { frontendLog } from "@/lib/frontend-logger";

import { createWebviewRouter, useWebviewRequests } from "./webview-messages";

const log = frontendLog.child("ui");

interface DialogListener {
  open: (request: JavaScriptDialogRequest) => void;
  close: (id: number) => void;
}

/** Main withdraws dialogs held for a webview no panel claims if the page goes away. */
const router = createWebviewRouter<DialogListener, JavaScriptDialogRequest>((listener, request) =>
  listener.open(request),
);
let listening = false;

export type JavaScriptDialogAnswer = Omit<JavaScriptDialogResponse, "id">;

function handleOpen(value: unknown): void {
  const parsed = javaScriptDialogRequestSchema.safeParse(value);
  if (!parsed.success) {
    log.warn("Ignoring malformed JavaScript dialog request", { error: parsed.error.message });
    return;
  }
  router.deliver(parsed.data.webContentsId, parsed.data);
}

function handleClosed(value: unknown): void {
  const parsed = javaScriptDialogClosedSchema.safeParse(value);
  if (!parsed.success) return;
  const { id, webContentsId } = parsed.data;
  router.withdraw(webContentsId, (request) => request.id === id)?.close(id);
}

/**
 * One window-wide subscription, kept for the window's lifetime and started when the first browser
 * panel mounts, before its webview loads a page.
 */
function listen(): void {
  if (listening) return;
  listening = true;
  window.electronAPI?.onJavaScriptDialog(handleOpen, handleClosed);
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
  const { requests, add, remove, clear } =
    useWebviewRequests<JavaScriptDialogRequest>(webContentsId);

  useEffect(() => {
    listen();
    if (webContentsId === null) return;
    return router.subscribe(webContentsId, { open: add, close: remove });
  }, [webContentsId, add, remove]);

  const dialog = requests[0] ?? null;
  const answer = useCallback(
    (reply: JavaScriptDialogAnswer) => {
      if (!dialog) return;
      window.electronAPI?.respondToJavaScriptDialog({ id: dialog.id, ...reply });
      remove(dialog.id);
    },
    [dialog, remove],
  );
  const dismissAll = useCallback(() => {
    for (const request of requests) {
      window.electronAPI?.respondToJavaScriptDialog({ id: request.id, ...dismissed });
    }
    if (requests.length > 0) clear();
  }, [requests, clear]);

  return { dialog, answer, dismissAll };
}
