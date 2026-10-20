// Preload for browser panel <webview> pages, set by main in will-attach-webview. Sandboxed, runs in
// every frame. Must be CJS (sandboxed Electron renderers cannot use ESM imports).
//
// Replaces the page's alert() / confirm() / prompt() — Electron throws on prompt() and shows the
// other two as sheets over the whole window — with ones that ask main synchronously, so the page
// blocks until the user answers the dialog Loxel shows in that panel. See javascript-dialogs.ts.
const { contextBridge, ipcRenderer } = require("electron");

// Must match JAVASCRIPT_DIALOG_RUN in ipc-channels.ts.
const JAVASCRIPT_DIALOG_RUN = "javascript-dialog:run";

contextBridge.executeInMainWorld({
  // Serialized into the page's world: it can only use its arguments and the page's globals.
  func: (runDialog) => {
    // Like browsers, ignore dialogs while the page is being left (beforeunload, pagehide).
    let leaving = false;
    let beforeUnload = false;
    addEventListener("beforeunload", () => {
      beforeUnload = true;
      setTimeout(() => {
        beforeUnload = false;
      }, 0);
    });
    addEventListener("pagehide", () => {
      leaving = true;
    });
    addEventListener("pageshow", () => {
      leaving = false;
    });

    // `${value}` converts like the DOMString arguments (throws for symbols); omitted → "".
    const text = (value) => (value === undefined ? "" : `${value}`);
    const run = (type, message, defaultValue) => {
      const call = { type, message: text(message), defaultValue: text(defaultValue) };
      return leaving || beforeUnload ? null : runDialog(call);
    };

    window.alert = function alert(...args) {
      run("alert", args[0], undefined);
    };
    window.confirm = function confirm(...args) {
      return run("confirm", args[0], undefined) === true;
    };
    window.prompt = function prompt(...args) {
      const result = run("prompt", args[0], args[1]);
      return typeof result === "string" ? result : null;
    };
  },
  args: [(call) => ipcRenderer.sendSync(JAVASCRIPT_DIALOG_RUN, call)],
});
