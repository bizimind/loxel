import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { UpdateState } from "@/api/update-model";
import { stubElectronAPI } from "@/test/electron-api-stub";

const originalClient = await import("@/api/client");
mock.module("@/api/client", () => ({
  ...originalClient,
  getVersion: jest.fn(async () => ({ version: "1.0.0", isDev: false })),
  putStore: jest.fn(async () => ({ success: true })),
}));

const { GeneralSection } = await import("./GeneralSection");
const { useSettingsStore } = await import("@/store/settings-store");

const checkForUpdates = jest.fn(async () => {});

function inDesktopApp(status: UpdateState = { state: "idle" }) {
  window.electronAPI = stubElectronAPI({ checkForUpdates, getUpdateStatus: async () => status });
}

function renderSection() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <GeneralSection />
    </QueryClientProvider>,
  );
}

function autoCheckSwitch(): HTMLElement {
  const row = screen.getByText("Check for updates automatically").parentElement;
  const toggle = row?.querySelector('[role="switch"]');
  if (!(toggle instanceof HTMLElement)) throw new Error("Automatic check switch not found");
  return toggle;
}

beforeEach(() => {
  checkForUpdates.mockClear();
  useSettingsStore.setState({ autoCheckForUpdates: true });
});

afterEach(() => {
  cleanup();
  delete window.electronAPI;
});

describe("GeneralSection automatic update check", () => {
  test("is on by default", () => {
    expect(useSettingsStore.getInitialState().autoCheckForUpdates).toBe(true);
  });

  test("the switch turns it off and on", () => {
    inDesktopApp();
    renderSection();
    const toggle = autoCheckSwitch();
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(toggle);
    expect(useSettingsStore.getState().autoCheckForUpdates).toBe(false);
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(toggle);
    expect(useSettingsStore.getState().autoCheckForUpdates).toBe(true);
  });

  test("the manual check stays available when it is off", () => {
    useSettingsStore.setState({ autoCheckForUpdates: false });
    inDesktopApp();
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
  });
});

describe("GeneralSection update status", () => {
  test("has no update controls outside the desktop app", () => {
    renderSection();
    expect(screen.queryByRole("button", { name: "Check for updates" })).toBeNull();
    expect(screen.queryByText("Check for updates automatically")).toBeNull();
  });

  test("shows download progress", async () => {
    inDesktopApp({ state: "downloading", version: "1.0.1", percent: 42 });
    renderSection();
    expect(await screen.findByRole("button", { name: "Downloading... 42%" })).toBeTruthy();
  });

  test("links to the download page when an update fails", async () => {
    inDesktopApp({ state: "error", message: "Cannot update while running on a read-only volume" });
    renderSection();
    const link = await screen.findByRole("link", { name: "Download the latest version" });
    expect(link.getAttribute("href")).toBe("https://bizimind.io/download");
  });
});
