import { describe, expect, mock, test } from "bun:test";

import {
  exclusiveAccessHeld,
  holdExclusiveAccess,
  ENTER_FULL_SCREEN_WAIT_MS,
  noteFullscreenGranted,
  noteRefusedWhileHeld,
  type Schedule,
  setWindowExclusiveAccessHold,
  trackHoldablePage,
  whileHoldingExclusiveAccess,
  windowSettled,
} from "./exclusive-access-holds";
import { EXCLUSIVE_ACCESS_REFUSED } from "./ipc-channels";

// Far from the IDs other test files hold, should they share this process.
let nextId = 1_000_000;
/** Window renderer IDs, from as far. */
const HOST = 1_000_000;

/** A browser panel page hosted by window renderer `hostId`, on patched Electron unless `stock`. */
function fakePage(hostId: number, { stock = false } = {}) {
  let destroyed = false;
  let onDestroyed = () => {};
  const exitExclusiveAccess = mock(() => {});
  const hostSend = mock((_channel: string, _payload: unknown) => {});
  const page = {
    id: nextId++,
    isDestroyed: () => destroyed,
    hostWebContents: { id: hostId, send: hostSend, isDestroyed: () => false },
    ...(stock ? {} : { exitExclusiveAccess }),
    once: (_event: "destroyed", listener: () => void) => {
      onDestroyed = listener;
    },
  };
  trackHoldablePage(page);
  const destroy = () => {
    destroyed = true;
    onDestroyed();
  };
  return { page, exitExclusiveAccess, destroy, hostSend };
}

describe("holdExclusiveAccess", () => {
  test("takes the page out of fullscreen and the pointer lock, and holds it until released", () => {
    const { page, exitExclusiveAccess } = fakePage(HOST + 100);
    const release = holdExclusiveAccess(page.id);
    expect(exitExclusiveAccess).toHaveBeenCalledTimes(1);
    expect(exclusiveAccessHeld(page.id)).toBe(true);
    release();
    expect(exclusiveAccessHeld(page.id)).toBe(false);
  });

  test("a page stays held until its last prompt closes, and a release counts once", () => {
    const { page } = fakePage(HOST + 100);
    const first = holdExclusiveAccess(page.id);
    const second = holdExclusiveAccess(page.id);
    first();
    first();
    expect(exclusiveAccessHeld(page.id)).toBe(true);
    second();
    expect(exclusiveAccessHeld(page.id)).toBe(false);
  });

  test("on stock Electron, without exitExclusiveAccess(), it only holds", () => {
    const { page } = fakePage(HOST + 100, { stock: true });
    const release = holdExclusiveAccess(page.id);
    expect(exclusiveAccessHeld(page.id)).toBe(true);
    release();
  });

  test("a webContents that isn't a tracked page, such as a popup, is only counted", () => {
    const release = holdExclusiveAccess(1_999_999);
    expect(exclusiveAccessHeld(1_999_999)).toBe(true);
    release();
    expect(exclusiveAccessHeld(1_999_999)).toBe(false);
  });

  test("a destroyed page is forgotten, and its prompt's late release is harmless", () => {
    const { page, exitExclusiveAccess, destroy } = fakePage(HOST + 100);
    const release = holdExclusiveAccess(page.id);
    destroy();
    expect(exclusiveAccessHeld(page.id)).toBe(false);
    release();
    expect(exitExclusiveAccess).toHaveBeenCalledTimes(1);
  });
});

describe("noteRefusedWhileHeld", () => {
  test("tells the page's panel, which points at the prompt holding it", () => {
    const { page, hostSend, destroy } = fakePage(HOST + 100);
    noteRefusedWhileHeld(page.id);
    expect(hostSend.mock.calls).toEqual([[EXCLUSIVE_ACCESS_REFUSED, page.id]]);
    destroy();
    noteRefusedWhileHeld(page.id);
    expect(hostSend).toHaveBeenCalledTimes(1);
  });
});

describe("whileHoldingExclusiveAccess", () => {
  test("holds the page while the dialog is open, and releases it however the dialog ends", async () => {
    const { page } = fakePage(HOST + 100);
    let close: (answer: number) => void = () => {};
    const answered = whileHoldingExclusiveAccess(
      page.id,
      () =>
        new Promise<number>((resolve) => {
          close = resolve;
        }),
    );
    expect(exclusiveAccessHeld(page.id)).toBe(true);
    close(2);
    expect(await answered).toBe(2);
    expect(exclusiveAccessHeld(page.id)).toBe(false);

    const failed = whileHoldingExclusiveAccess(page.id, () => Promise.reject(new Error("gone")));
    await expect(failed).rejects.toThrow("gone");
    expect(exclusiveAccessHeld(page.id)).toBe(false);
  });
});

describe("window holds", () => {
  test("a modal over the window takes back every page it hosts, and no other window's", () => {
    const first = fakePage(HOST + 200);
    const second = fakePage(HOST + 200);
    const elsewhere = fakePage(HOST + 201);
    setWindowExclusiveAccessHold(HOST + 200, true);
    expect(first.exitExclusiveAccess).toHaveBeenCalledTimes(1);
    expect(second.exitExclusiveAccess).toHaveBeenCalledTimes(1);
    expect(elsewhere.exitExclusiveAccess).not.toHaveBeenCalled();
    expect(exclusiveAccessHeld(first.page.id)).toBe(true);
    expect(exclusiveAccessHeld(elsewhere.page.id)).toBe(false);
    setWindowExclusiveAccessHold(HOST + 200, false);
    expect(exclusiveAccessHeld(first.page.id)).toBe(false);
  });
});

describe("a window animating into fullscreen", () => {
  /** A schedule the test runs by hand: `fire()` is the wait's timeout passing. */
  function manualSchedule() {
    let pending: (() => void) | null = null;
    const schedule: Schedule = (callback, ms) => {
      expect(ms).toBe(ENTER_FULL_SCREEN_WAIT_MS);
      pending = callback;
      return () => {
        pending = null;
      };
    };
    return { schedule, fire: () => pending?.(), scheduled: () => pending !== null };
  }

  test("a hold waits for the window to finish entering before taking the page out", () => {
    const { schedule, scheduled } = manualSchedule();
    const { page, exitExclusiveAccess } = fakePage(HOST + 300);
    noteFullscreenGranted(HOST + 300, false, schedule);
    const release = holdExclusiveAccess(page.id);
    expect(exitExclusiveAccess).not.toHaveBeenCalled();
    // The page is held meanwhile, so it can't take the screen again.
    expect(exclusiveAccessHeld(page.id)).toBe(true);
    windowSettled(HOST + 300);
    expect(exitExclusiveAccess).toHaveBeenCalledTimes(1);
    expect(scheduled()).toBe(false);
    // Settled: the next hold exits at once, and a later settle runs nothing again.
    const again = holdExclusiveAccess(page.id);
    expect(exitExclusiveAccess).toHaveBeenCalledTimes(2);
    windowSettled(HOST + 300);
    expect(exitExclusiveAccess).toHaveBeenCalledTimes(2);
    release();
    again();
  });

  test("covers pages held by their window's modal too", () => {
    const { schedule } = manualSchedule();
    const { exitExclusiveAccess } = fakePage(HOST + 301);
    noteFullscreenGranted(HOST + 301, false, schedule);
    setWindowExclusiveAccessHold(HOST + 301, true);
    expect(exitExclusiveAccess).not.toHaveBeenCalled();
    windowSettled(HOST + 301);
    expect(exitExclusiveAccess).toHaveBeenCalledTimes(1);
    setWindowExclusiveAccessHold(HOST + 301, false);
  });

  test("a prompt that closed before the window settled takes nothing", () => {
    const { schedule } = manualSchedule();
    const { page, exitExclusiveAccess } = fakePage(HOST + 302);
    noteFullscreenGranted(HOST + 302, false, schedule);
    holdExclusiveAccess(page.id)();
    windowSettled(HOST + 302);
    expect(exitExclusiveAccess).not.toHaveBeenCalled();
  });

  test("a window that never says it settled is taken as settled after the wait", () => {
    const { schedule, fire } = manualSchedule();
    const { page, exitExclusiveAccess } = fakePage(HOST + 303);
    noteFullscreenGranted(HOST + 303, false, schedule);
    const release = holdExclusiveAccess(page.id);
    fire();
    expect(exitExclusiveAccess).toHaveBeenCalledTimes(1);
    release();
  });

  test("a page going fullscreen in a window already fullscreen is taken out at once", () => {
    const { schedule, scheduled } = manualSchedule();
    const { page, exitExclusiveAccess } = fakePage(HOST + 304);
    noteFullscreenGranted(HOST + 304, true, schedule);
    expect(scheduled()).toBe(false);
    const release = holdExclusiveAccess(page.id);
    expect(exitExclusiveAccess).toHaveBeenCalledTimes(1);
    release();
  });

  test("only that window's pages wait", () => {
    const { schedule } = manualSchedule();
    const elsewhere = fakePage(HOST + 306);
    noteFullscreenGranted(HOST + 305, false, schedule);
    const release = holdExclusiveAccess(elsewhere.page.id);
    expect(elsewhere.exitExclusiveAccess).toHaveBeenCalledTimes(1);
    release();
    windowSettled(HOST + 305);
  });
});
