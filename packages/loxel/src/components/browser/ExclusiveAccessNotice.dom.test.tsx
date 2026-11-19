import { afterEach, describe, expect, jest, test } from "bun:test";

import { act, cleanup, render, screen } from "@testing-library/react";

import { stubElectronAPI } from "@/test/electron-api-stub";

import { ExclusiveAccessNotice, NOTICE_MS } from "./ExclusiveAccessNotice";

let show: (notice: unknown) => void = () => {};
let hide: (webContentsId: unknown) => void = () => {};
let subscriptions = 0;

function installBridge(): void {
  window.electronAPI = stubElectronAPI({
    onExclusiveAccessNotice: (onShow, onHide) => {
      subscriptions++;
      show = onShow;
      hide = onHide;
      return () => {};
    },
  });
}

const noWebview = { current: null };

afterEach(() => {
  cleanup();
  jest.useRealTimers();
  delete window.electronAPI;
  subscriptions = 0;
});

describe("ExclusiveAccessNotice", () => {
  test("names the site and how to leave, only in its own panel", () => {
    installBridge();
    render(
      <>
        <ExclusiveAccessNotice webContentsId={1} webviewRef={noWebview} />
        <ExclusiveAccessNotice webContentsId={2} webviewRef={noWebview} />
      </>,
    );
    expect(subscriptions).toBe(1);

    act(() =>
      show({
        webContentsId: 2,
        origin: "https://video.example",
        fullscreen: true,
        pointerLock: false,
      }),
    );
    const notice = screen.getByRole("status");
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(notice.textContent).toBe("video.example is now full screen. Press Esc to exit.");
    expect(notice.hasAttribute("data-popover-open")).toBe(true);

    act(() =>
      show({
        webContentsId: 1,
        origin: "http://localhost:5173",
        fullscreen: false,
        pointerLock: true,
      }),
    );
    expect(screen.getAllByRole("status").map((n) => n.textContent)).toEqual([
      "localhost:5173 has hidden your pointer. Press Esc to show it.",
      "video.example is now full screen. Press Esc to exit.",
    ]);
  });

  test("goes away after a few seconds, and shows again on every entry", () => {
    jest.useFakeTimers();
    installBridge();
    render(<ExclusiveAccessNotice webContentsId={1} webviewRef={noWebview} />);
    const entry = {
      webContentsId: 1,
      origin: "https://video.example",
      fullscreen: true,
      pointerLock: false,
    };

    act(() => show(entry));
    act(() => jest.advanceTimersByTime(NOTICE_MS - 1));
    expect(screen.getByRole("status")).toBeTruthy();
    // A new entry restarts the countdown.
    act(() => show(entry));
    act(() => jest.advanceTimersByTime(NOTICE_MS - 1));
    expect(screen.getByRole("status")).toBeTruthy();
    act(() => jest.advanceTimersByTime(1));
    expect(screen.queryByRole("status")).toBeNull();

    act(() => show(entry));
    expect(screen.getByRole("status")).toBeTruthy();
  });

  test("says it once when the page took both the screen and the pointer", () => {
    installBridge();
    render(<ExclusiveAccessNotice webContentsId={1} webviewRef={noWebview} />);
    act(() =>
      show({
        webContentsId: 1,
        origin: "https://game.example",
        fullscreen: true,
        pointerLock: true,
      }),
    );
    expect(screen.getByRole("status").textContent).toBe(
      "game.example is now full screen and has hidden your pointer. Press Esc to exit.",
    );
  });

  test("a panel that remounts doesn't show an expired notice again", () => {
    jest.useFakeTimers();
    installBridge();
    const panel = render(<ExclusiveAccessNotice webContentsId={1} webviewRef={noWebview} />);
    act(() =>
      show({
        webContentsId: 1,
        origin: "https://video.example",
        fullscreen: true,
        pointerLock: false,
      }),
    );
    const other = render(<ExclusiveAccessNotice webContentsId={2} webviewRef={noWebview} />);
    panel.unmount();
    act(() => jest.advanceTimersByTime(NOTICE_MS));
    render(<ExclusiveAccessNotice webContentsId={1} webviewRef={noWebview} />);
    expect(screen.queryByRole("status")).toBeNull();
    other.unmount();
  });

  test("leaving fullscreen hides it", () => {
    installBridge();
    render(<ExclusiveAccessNotice webContentsId={1} webviewRef={noWebview} />);
    act(() =>
      show({
        webContentsId: 1,
        origin: "https://video.example",
        fullscreen: true,
        pointerLock: false,
      }),
    );
    act(() => hide(1));
    expect(screen.queryByRole("status")).toBeNull();
  });

  test("ignores malformed payloads", () => {
    installBridge();
    render(<ExclusiveAccessNotice webContentsId={1} webviewRef={noWebview} />);
    act(() => show({ webContentsId: 1, origin: "https://video.example" }));
    act(() =>
      show({
        webContentsId: 1,
        origin: "https://video.example",
        fullscreen: false,
        pointerLock: false,
      }),
    );
    act(() => show({ webContentsId: 1, fullscreen: true, pointerLock: false, title: "Loxel" }));
    expect(screen.queryByRole("status")).toBeNull();
  });
});
