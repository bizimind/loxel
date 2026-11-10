import { afterEach, describe, expect, test } from "bun:test";

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import { stubElectronAPI } from "@/test/electron-api-stub";

import { PasskeyQrOverlay } from "./PasskeyQrOverlay";

let show: (request: unknown) => void = () => {};
let hide: (webContentsId: unknown) => void = () => {};
let subscriptions = 0;

function installBridge(): void {
  window.electronAPI = stubElectronAPI({
    onPasskeyQrCode: (onShow, onHide) => {
      subscriptions++;
      show = onShow;
      hide = onHide;
      return () => {};
    },
  });
}

function request(webContentsId: number) {
  return { webContentsId, relyingPartyId: "example.com", requestType: "get", qrCode: "FIDO:/123" };
}

afterEach(() => {
  cleanup();
  delete window.electronAPI;
  subscriptions = 0;
});

describe("PasskeyQrOverlay", () => {
  test("shows a request only in its own panel, until it ends", () => {
    installBridge();
    render(
      <>
        <PasskeyQrOverlay webContentsId={1} />
        <PasskeyQrOverlay webContentsId={2} />
      </>,
    );
    expect(subscriptions).toBe(1);

    act(() => show(request(2)));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByText("example.com")).toBeTruthy();

    act(() => hide(2));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("ignores malformed payloads", () => {
    installBridge();
    render(<PasskeyQrOverlay webContentsId={1} />);
    act(() => show({ ...request(1), qrCode: "https://example.com" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("the user can hide the code", () => {
    installBridge();
    render(<PasskeyQrOverlay webContentsId={1} />);
    act(() => show(request(1)));
    fireEvent.click(screen.getByRole("button", { name: "Hide QR code" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
