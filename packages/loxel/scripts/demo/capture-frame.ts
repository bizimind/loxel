/**
 * Capture the window frame every site screenshot is composited into: one real demo window,
 * brought to the front for a moment and saved with `screencapture` (rounded corners, border,
 * traffic lights, shadow) to window-frame.png. Rerun only when macOS's window style changes.
 * Needs Screen Recording access for the terminal app.
 *
 * Usage: bun scripts/demo/capture-frame.ts
 */
import { resolve } from "node:path";

import { $ } from "bun";

import { FRAME_FILE, launchDemo } from "./demo-session";

const session = await launchDemo({ hidden: false });
try {
  await session.app.evaluate(({ app, BrowserWindow }) => {
    app.focus({ steal: true });
    const [win] = BrowserWindow.getAllWindows();
    if (!win) throw new Error("The demo app has no window");
    win.focus();
  });
  // The traffic lights only take their color once the window is key; wait for the renderer to
  // hear it before capturing.
  await session.page.waitForFunction(() => document.hasFocus());
  const pid = session.app.process().pid;
  const windowId = (
    await $`swift ${resolve(import.meta.dirname, "window-id.swift")} ${pid}`.text()
  ).trim();
  await $`screencapture -x -l${windowId} ${FRAME_FILE}`;
  console.log(`Saved ${FRAME_FILE}`);
} finally {
  await session.close();
}
