/**
 * `alert()` / `confirm()` / `prompt()` for browser panel pages, shown as a Loxel dialog over the
 * page's own panel instead of Electron's handling (prompt() throws; alert() and confirm() are
 * native sheets that block the whole window).
 *
 * The webview preload (`webview-preload.cjs`) replaces the page's dialog functions with a
 * synchronous IPC call, so the page blocks like with a real dialog. Main forwards the call to the
 * window renderer hosting the webview and sets the IPC's return value once the user answers.
 * Only that page's renderer is blocked; the window and its other panels keep working.
 *
 * Abuse protection follows browsers: from a page's second dialog on, the user can block further
 * dialogs from it until it navigates, and a page being navigated away from gets no dialogs.
 */
import path from "node:path";

import {
  type IpcMainEvent,
  type WebContents,
  type WebFrameMain,
  type WebPreferences,
  ipcMain,
} from "electron";

import {
  JAVASCRIPT_DIALOG_CLOSED,
  JAVASCRIPT_DIALOG_LISTEN,
  JAVASCRIPT_DIALOG_OPEN,
  JAVASCRIPT_DIALOG_RESPOND,
  JAVASCRIPT_DIALOG_RUN,
} from "./ipc-channels";
import {
  type JavaScriptDialogClosed,
  type JavaScriptDialogRequest,
  type JavaScriptDialogResponse,
  type JavaScriptDialogType,
  javaScriptDialogResponseSchema,
  pageDialogCallSchema,
} from "./javascript-dialog-protocol";

/** Longer messages are cut: rendering megabytes of page text would stall the whole window. */
const MAX_DIALOG_TEXT = 10_000;

interface PendingDialog {
  /** The page's blocked `sendSync`; setting its `returnValue` unblocks the page. */
  event: IpcMainEvent;
  type: JavaScriptDialogType;
  guestId: number;
  /** The window renderer showing the dialog — the only one allowed to answer it. */
  host: WebContents;
}

/** Dialog state per guest webContents, reset when its main frame commits a new document. */
interface PageDialogState {
  shown: number;
  /** The user chose to block further dialogs from this page. */
  suppressed: boolean;
  /** A main-frame navigation is under way: the outgoing page gets no more dialogs. */
  leaving: boolean;
}

const pendingDialogs = new Map<number, PendingDialog>();
const pageStates = new Map<number, PageDialogState>();
/** Window renderers whose current document shows dialogs (renderers that predate them don't). */
const listeningHosts = new Set<number>();
let nextDialogId = 1;

/** What the page's dialog function returns when the dialog isn't shown or is dismissed. */
function dismissedResult(type: JavaScriptDialogType): boolean | null {
  return type === "confirm" ? false : null;
}

function dialogResult(
  type: JavaScriptDialogType,
  response: JavaScriptDialogResponse,
): boolean | string | null {
  if (type === "confirm") return response.accepted;
  if (type === "prompt") return response.accepted ? response.value : null;
  return null;
}

function capText(text: string): string {
  return text.length > MAX_DIALOG_TEXT ? `${text.slice(0, MAX_DIALOG_TEXT)}…` : text;
}

function originLabel(origin: string): string | null {
  try {
    const { protocol, host } = new URL(origin);
    return (protocol === "http:" || protocol === "https:") && host ? host : null;
  } catch {
    return null;
  }
}

/** "localhost:5173 says", like browsers; an iframe from another origin is named as embedded. */
function dialogTitle(frame: WebFrameMain, mainFrame: WebFrameMain): string {
  const label = originLabel(frame.origin);
  const embedded = frame !== mainFrame && frame.origin !== mainFrame.origin;
  if (!embedded) return label ? `${label} says` : "This page says";
  return label ? `An embedded page at ${label} says` : "An embedded page on this page says";
}

function pageState(guestId: number): PageDialogState {
  let state = pageStates.get(guestId);
  if (!state) {
    state = { shown: 0, suppressed: false, leaving: false };
    pageStates.set(guestId, state);
  }
  return state;
}

/** Dismiss a guest's pending dialogs (all, or those `matching`) and withdraw them. */
function dismissDialogs(
  guestId: number,
  matching: (dialog: PendingDialog) => boolean = () => true,
): void {
  for (const [id, dialog] of pendingDialogs) {
    if (dialog.guestId !== guestId || !matching(dialog)) continue;
    pendingDialogs.delete(id);
    dialog.event.returnValue = dismissedResult(dialog.type);
    if (dialog.host.isDestroyed()) continue;
    const closed: JavaScriptDialogClosed = { id, webContentsId: guestId };
    dialog.host.send(JAVASCRIPT_DIALOG_CLOSED, closed);
  }
}

function isGone(frame: WebFrameMain | null): boolean {
  return !frame || frame.detached;
}

function runDialog(event: IpcMainEvent, value: unknown): void {
  const call = pageDialogCallSchema.safeParse(value);
  if (!call.success) {
    event.returnValue = null;
    return;
  }
  const { type, message, defaultValue } = call.data;
  const guest = event.sender;
  const frame = event.senderFrame;
  const host = guest.getType() === "webview" ? guest.hostWebContents : null;
  if (!host || host.isDestroyed() || !listeningHosts.has(host.id) || !frame || isGone(frame)) {
    event.returnValue = dismissedResult(type);
    return;
  }
  const state = pageState(guest.id);
  if (state.suppressed || state.leaving) {
    event.returnValue = dismissedResult(type);
    return;
  }

  const id = nextDialogId++;
  pendingDialogs.set(id, { event, type, guestId: guest.id, host });
  const request: JavaScriptDialogRequest = {
    id,
    webContentsId: guest.id,
    type,
    title: dialogTitle(frame, guest.mainFrame),
    message: capText(message),
    defaultValue: capText(defaultValue),
    canSuppress: state.shown > 0,
  };
  state.shown++;
  host.send(JAVASCRIPT_DIALOG_OPEN, request);
}

function respondToDialog(event: IpcMainEvent, value: unknown): void {
  const parsed = javaScriptDialogResponseSchema.safeParse(value);
  if (!parsed.success) return;
  const response = parsed.data;
  const dialog = pendingDialogs.get(response.id);
  if (!dialog || dialog.host !== event.sender || event.senderFrame !== dialog.host.mainFrame) {
    return;
  }
  pendingDialogs.delete(response.id);
  dialog.event.returnValue = dialogResult(dialog.type, response);
  if (!response.suppress) return;
  pageState(dialog.guestId).suppressed = true;
  // Blocking also clears the page's other queued dialogs (e.g. from several iframes).
  dismissDialogs(dialog.guestId);
}

interface NavigationDetails {
  isMainFrame: boolean;
  isSameDocument: boolean;
}

/** A window renderer subscribed to dialogs; valid until its document is replaced. */
function listen(event: IpcMainEvent): void {
  const host = event.sender;
  if (listeningHosts.has(host.id)) return;
  listeningHosts.add(host.id);
  const forget = () => {
    listeningHosts.delete(host.id);
    host.off("did-start-navigation", onNavigation);
  };
  const onNavigation = ({ isMainFrame, isSameDocument }: NavigationDetails) => {
    if (isMainFrame && !isSameDocument) forget();
  };
  host.on("did-start-navigation", onNavigation);
  host.once("destroyed", () => listeningHosts.delete(host.id));
}

export function installJavaScriptDialogs(): void {
  ipcMain.on(JAVASCRIPT_DIALOG_RUN, runDialog);
  ipcMain.on(JAVASCRIPT_DIALOG_RESPOND, respondToDialog);
  ipcMain.on(JAVASCRIPT_DIALOG_LISTEN, listen);
}

/** Load the dialog preload into a webview (from `will-attach-webview`, after its own is stripped). */
export function configureWebviewDialogs(webPreferences: WebPreferences): void {
  webPreferences.preload = path.join(import.meta.dirname, "webview-preload.cjs");
  webPreferences.sandbox = true;
  // Run the preload in iframes too so embedded pages get the same dialogs. Sandboxed, so this
  // gives no frame Node.js; it only loads the preload.
  webPreferences.nodeIntegrationInSubFrames = true;
  // Frames the preload doesn't reach (about:blank iframes) get no dialog rather than Electron's
  // sheet over the whole window, which also bypasses the per-page blocking.
  webPreferences.disableDialogs = true;
}

/** Track a webview's page lifecycle for its dialogs (from `web-contents-created`). */
export function trackWebviewDialogs(contents: WebContents): void {
  if (contents.getType() !== "webview") return;
  const guestId = contents.id;
  // Browsers dismiss a page's dialogs when it navigates, and give the page being left no new
  // ones. The navigation waits for a blocked page, so a dialog kept open (or one opened right
  // after) would hold up the toolbar's reload or a new URL.
  contents.on("did-start-navigation", ({ isMainFrame, isSameDocument }) => {
    if (!isMainFrame || isSameDocument) return;
    pageState(guestId).leaving = true;
    dismissDialogs(guestId);
  });
  const navigationEnded = () => {
    const state = pageStates.get(guestId);
    if (state) state.leaving = false;
  };
  // A new document starts over: its first dialog has no block option, and blocking is lifted.
  // Dialogs still pending from frames of the old document (another process) are dismissed.
  contents.on("did-navigate", () => {
    pageStates.delete(guestId);
    dismissDialogs(guestId, ({ event }) => isGone(event.senderFrame));
  });
  // Navigations that don't commit (failed, stopped, downloads, 204) leave the page in place.
  contents.on("did-fail-load", (_event, _code, _description, _url, isMainFrame) => {
    if (isMainFrame) navigationEnded();
  });
  contents.on("did-stop-loading", navigationEnded);
  contents.on("render-process-gone", () => dismissDialogs(guestId));
  contents.once("destroyed", () => {
    dismissDialogs(guestId);
    pageStates.delete(guestId);
  });
}
