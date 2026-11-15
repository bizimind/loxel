/**
 * The question before a quit that would end terminals running programs: Quit Loxel, the Dock's
 * Quit and the like while "When quitting Loxel" is set to ask. Main lists the terminals from its
 * server and asks in a window of the app, natively only when no window can show the question.
 * See docs/SHARED_SERVER.md#server-lifecycle.
 */
import { app, type BrowserWindow, dialog, type IpcMainEvent, ipcMain } from "electron";

import { type RunningTerminal, RunningTerminalsSchema } from "../api/running-terminals-model";
import { awakeTimeout } from "../lib/awake-timer";
import {
  QUIT_ANSWER_LABELS,
  type QuitAnswer,
  type QuitConfirmation,
  type QuitQuestion,
  QuitReplySchema,
  quitConfirmation,
} from "../lib/quit-terminals";
import {
  QUIT_ANSWER,
  QUIT_QUESTION,
  QUIT_QUESTION_SHOWN,
  QUIT_QUESTION_WITHDRAWN,
} from "./ipc-channels";

/**
 * How long listing the terminals may take before the question is asked without the list. Longer
 * than the server's own wait for a terminal host's foreground programs
 * (`REQUEST_TIMEOUTS_MS.foreground_processes`, 5 seconds), so a slow host costs only its own
 * terminals' programs, which are then counted, not the whole list.
 */
const LIST_TIMEOUT_MS = 8000;

/** How long a window has to put the question on screen before it is asked natively instead. */
const SHOW_TIMEOUT_MS = 3000;

export interface QuitQuestionOptions {
  /** The window to ask in, read once the terminals are listed; undefined when none is open. */
  window: () => BrowserWindow | undefined;
  /** Aborted when the quit is decided some other way meanwhile (Quit and Keep Terminals). */
  signal: AbortSignal;
}

/**
 * Ask what to do with the terminals before quitting. Resolves `end` at once when no terminal runs
 * a program, and `cancel` when `signal` is aborted before the user answers.
 */
export async function askBeforeQuitting(
  serverUrl: string,
  options: QuitQuestionOptions,
): Promise<QuitAnswer> {
  const confirmation = quitConfirmation(await listTerminalsForQuit(serverUrl));
  if (options.signal.aborted) return "cancel";
  if (!confirmation) return "end";
  const win = options.window();
  if (win) {
    const answer = await askInWindow(win, confirmation, options.signal);
    if (answer !== "unshown") return answer;
    console.warn("[electron] The window did not show the quit question; asking natively");
  }
  if (options.signal.aborted) return "cancel";
  return askNatively(confirmation);
}

/**
 * The terminals the server runs, with their foreground programs where their terminal host can tell,
 * or null when the server does not answer in time. The wait counts only time the machine is
 * awake, so a laptop that sleeps while the request is out does not give up on waking.
 */
async function listTerminalsForQuit(serverUrl: string): Promise<RunningTerminal[] | null> {
  const controller = new AbortController();
  const cancel = awakeTimeout(LIST_TIMEOUT_MS, () => controller.abort());
  try {
    const res = await fetch(`${serverUrl}/api/terminals?programs`, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return RunningTerminalsSchema.parse(await res.json()).terminals;
  } catch (err) {
    console.warn("[electron] Could not list the terminals before quitting:", err);
    return null;
  } finally {
    cancel();
  }
}

let nextQuestionId = 1;

/**
 * Ask in `win`'s renderer (`QuitQuestionHost`). `unshown` when the renderer does not report the
 * question on screen in time, or loses it: hung, crashed, still loading, or reloading. A window
 * closed after showing it is a Cancel. A question main stops waiting on without the renderer's
 * answer is withdrawn from the window, so no answer is left that nothing hears.
 */
function askInWindow(
  win: BrowserWindow,
  confirmation: QuitConfirmation,
  signal: AbortSignal,
): Promise<QuitAnswer | "unshown"> {
  if (win.isDestroyed()) return Promise.resolve("unshown");
  const contents = win.webContents;
  const question: QuitQuestion = { id: nextQuestionId++, confirmation };
  return new Promise((resolve) => {
    let shown = false;
    const fromThisWindow = (event: IpcMainEvent) => event.sender === contents;
    const onShown = (event: IpcMainEvent, id: unknown) => {
      if (!fromThisWindow(event) || id !== question.id) return;
      shown = true;
      cancelShowTimeout();
    };
    const onAnswer = (event: IpcMainEvent, raw: unknown) => {
      const reply = QuitReplySchema.safeParse(raw);
      if (!fromThisWindow(event) || !reply.success || reply.data.id !== question.id) return;
      finish(reply.data.answer, true);
    };
    const onClosed = () => finish(shown ? "cancel" : "unshown");
    const onGone = () => finish("unshown");
    const onNavigation = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
      if (details.isMainFrame && !details.isSameDocument) finish("unshown");
    };
    const onAbort = () => finish("cancel");
    const cancelShowTimeout = awakeTimeout(SHOW_TIMEOUT_MS, () => {
      if (!shown) finish("unshown");
    });
    function finish(answer: QuitAnswer | "unshown", answered = false): void {
      cancelShowTimeout();
      ipcMain.removeListener(QUIT_QUESTION_SHOWN, onShown);
      ipcMain.removeListener(QUIT_ANSWER, onAnswer);
      win.removeListener("closed", onClosed);
      signal.removeEventListener("abort", onAbort);
      if (!contents.isDestroyed()) {
        contents.removeListener("render-process-gone", onGone);
        contents.removeListener("did-start-navigation", onNavigation);
        if (!answered) contents.send(QUIT_QUESTION_WITHDRAWN, question.id);
      }
      resolve(answer);
    }

    ipcMain.on(QUIT_QUESTION_SHOWN, onShown);
    ipcMain.on(QUIT_ANSWER, onAnswer);
    win.once("closed", onClosed);
    contents.once("render-process-gone", onGone);
    contents.on("did-start-navigation", onNavigation);
    signal.addEventListener("abort", onAbort, { once: true });
    // A quit from the Dock may come while another app is in front.
    if (win.isMinimized()) win.restore();
    win.show();
    app.focus({ steal: true });
    contents.send(QUIT_QUESTION, question);
  });
}

/** The answers in the native dialog's button order: the default first, Cancel last. */
const NATIVE_ANSWERS: readonly QuitAnswer[] = ["keep", "end", "cancel"];

async function askNatively(confirmation: QuitConfirmation): Promise<QuitAnswer> {
  const programs = confirmation.busy.map(({ program, worktree }) => `${program} in ${worktree}`);
  const { response } = await dialog.showMessageBox({
    type: "warning",
    message: confirmation.title,
    detail: [confirmation.message, ...(programs.length > 0 ? ["", ...programs] : [])].join("\n"),
    buttons: NATIVE_ANSWERS.map((answer) => QUIT_ANSWER_LABELS[answer]),
    defaultId: 0,
    cancelId: NATIVE_ANSWERS.indexOf("cancel"),
  });
  return NATIVE_ANSWERS[response] ?? "cancel";
}
