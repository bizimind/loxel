import { beforeEach, describe, expect, mock, test } from "bun:test";

import { JAVASCRIPT_DIALOG_RUN } from "./ipc-channels";

interface DialogCall {
  type: string;
  message: string;
  defaultValue: string;
}
interface PageDialogs {
  alert: (...args: unknown[]) => void;
  confirm: (...args: unknown[]) => boolean;
  prompt: (...args: unknown[]) => string | null;
}
type InstallDialogs = (runDialog: (call: DialogCall) => unknown) => void;

let script: { func: InstallDialogs; args: [(call: DialogCall) => unknown] } | undefined;
const sendSync = mock((_channel: string, _call: DialogCall): unknown => null);
void mock.module("electron", () => ({
  contextBridge: { executeInMainWorld: (s: NonNullable<typeof script>) => (script = s) },
  ipcRenderer: { sendSync },
}));
await import("./webview-preload.cjs");
if (!script) throw new Error("the preload installed nothing in the main world");
const { func: installDialogs, args } = script;

/** Run the main-world function against a stub page; returns its dialogs and page events. */
function stubPage(answer: (call: DialogCall) => unknown) {
  const listeners = new Map<string, () => void>();
  const page = {} as PageDialogs;
  const runDialog = mock(answer);
  Object.assign(globalThis, {
    window: page,
    addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
  });
  installDialogs(runDialog);
  const fire = (type: string) => listeners.get(type)?.();
  return { page, runDialog, fire };
}

beforeEach(() => sendSync.mockClear());

describe("webview preload", () => {
  test("asks main synchronously on the dialog channel", () => {
    const call = { type: "alert", message: "hi", defaultValue: "" };
    sendSync.mockReturnValueOnce("answer");
    expect(args[0](call)).toBe("answer");
    expect(sendSync).toHaveBeenCalledWith(JAVASCRIPT_DIALOG_RUN, call);
  });

  test("converts arguments like the DOM's dialog functions", () => {
    const { page, runDialog } = stubPage(() => null);
    page.alert();
    page.alert(null);
    page.alert(undefined);
    page.confirm(undefined);
    page.confirm({});
    page.prompt("Name?", undefined);
    page.prompt(42, 7);
    expect(runDialog.mock.calls.map(([call]) => call)).toEqual([
      { type: "alert", message: "", defaultValue: "" },
      { type: "alert", message: "null", defaultValue: "" },
      { type: "alert", message: "undefined", defaultValue: "" },
      { type: "confirm", message: "", defaultValue: "" },
      { type: "confirm", message: "[object Object]", defaultValue: "" },
      { type: "prompt", message: "Name?", defaultValue: "" },
      { type: "prompt", message: "42", defaultValue: "7" },
    ]);
    expect(() => page.alert(Symbol("no"))).toThrow(TypeError);
    expect(runDialog).toHaveBeenCalledTimes(7);
  });

  test("returns what browsers return", () => {
    const answers: unknown[] = [true, "yes", "typed", 5, null, "ignored"];
    const { page } = stubPage(() => answers.shift());
    expect(page.confirm()).toBe(true);
    expect(page.confirm()).toBe(false);
    expect(page.prompt()).toBe("typed");
    expect(page.prompt()).toBeNull();
    expect(page.prompt()).toBeNull();
    expect(page.alert()).toBeUndefined();
  });

  test("keeps the functions' names and arity", () => {
    const { page } = stubPage(() => null);
    expect([page.alert, page.confirm, page.prompt].map((f) => [f.name, f.length])).toEqual([
      ["alert", 0],
      ["confirm", 0],
      ["prompt", 0],
    ]);
  });

  test("ignores dialogs while the page is being left", async () => {
    const { page, runDialog, fire } = stubPage(() => true);
    fire("beforeunload");
    expect(page.confirm("Leave?")).toBe(false);
    expect(page.prompt("Why?")).toBeNull();
    // The page stays if the unload is cancelled.
    await Bun.sleep(1);
    expect(page.confirm("Still here?")).toBe(true);

    fire("pagehide");
    expect(page.confirm("Gone?")).toBe(false);
    fire("pageshow"); // back from the back/forward cache
    expect(page.confirm("Back?")).toBe(true);
    expect(runDialog).toHaveBeenCalledTimes(2);
  });
});
