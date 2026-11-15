import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import type { RunningTerminal } from "@/api/running-terminals-model";
import type { UpdateState } from "@/api/update-model";
import { stubElectronAPI } from "@/test/electron-api-stub";

const originalClient = await import("@/api/client");
mock.module("@/api/client", () => ({
  ...originalClient,
  getVersion: jest.fn(async () => ({ version: "1.0.0", isDev: false })),
  putStore: jest.fn(async () => ({ success: true })),
  getRunningTerminals: jest.fn(async ({ programs }: { programs: boolean }) =>
    running.map((terminal) => (programs ? terminal : { ...terminal, program: undefined })),
  ),
}));

/** What the server runs, as `GET /api/terminals?programs` reports it. */
let running: RunningTerminal[] = [];

const { GeneralSection } = await import("./GeneralSection");
const { ConfirmDialogHost } = await import("@/components/ui/confirm-dialog-host");
const { useSettingsStore } = await import("@/store/settings-store");

const checkForUpdates = jest.fn(async () => {});
const installUpdate = jest.fn(() => {});

function inDesktopApp(status: UpdateState = { state: "idle" }) {
  window.electronAPI = stubElectronAPI({
    checkForUpdates,
    installUpdate,
    getUpdateStatus: async () => status,
  });
}

function renderSection() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <GeneralSection />
      <ConfirmDialogHost />
    </QueryClientProvider>,
  );
}

function terminal(program: string | null): RunningTerminal {
  return {
    id: crypto.randomUUID(),
    worktreePath: "/projects/shop/feat-cart",
    cwd: "/projects/shop/feat-cart",
    otherHostBuild: false,
    program,
  };
}

function openDialog(): HTMLElement {
  const dialog = document.querySelector<HTMLElement>("dialog[open]");
  if (!dialog) throw new Error("No confirmation is open");
  return dialog;
}

function autoCheckSwitch(): HTMLElement {
  const row = screen.getByText("Check for updates automatically").parentElement;
  const toggle = row?.querySelector('[role="switch"]');
  if (!(toggle instanceof HTMLElement)) throw new Error("Automatic check switch not found");
  return toggle;
}

beforeEach(() => {
  checkForUpdates.mockClear();
  installUpdate.mockClear();
  running = [];
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
    inDesktopApp({ state: "downloading", version: "1.0.1", percent: 42, restartsTerminals: false });
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

describe("GeneralSection default browser", () => {
  function onMac(overrides: Parameters<typeof stubElectronAPI>[0]) {
    window.electronAPI = stubElectronAPI({ macOSVersion: "15.0.0", ...overrides });
  }

  test("asks macOS to make Loxel the default, and shows it once it is", async () => {
    const setAsDefaultBrowser = jest.fn(async () => ({ isDefault: true, canSet: true }));
    onMac({
      getDefaultBrowserStatus: async () => ({ isDefault: false, canSet: true }),
      setAsDefaultBrowser,
    });
    renderSection();

    const button = await screen.findByRole("button", { name: "Set as default browser" });
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    fireEvent.click(button);

    expect(setAsDefaultBrowser).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Loxel is your default web browser")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Set as default browser" })).toBeNull();
  });

  test("reads the status again when the window comes back from macOS's prompt", async () => {
    let focusChange: (focused: boolean) => void = () => {};
    let isDefault = false;
    onMac({
      getDefaultBrowserStatus: async () => ({ isDefault, canSet: true }),
      onWindowFocusChange: (callback) => {
        focusChange = callback;
        return () => {};
      },
    });
    renderSection();
    await screen.findByText("Open web links in Loxel");

    isDefault = true;
    act(() => focusChange(true));
    expect(await screen.findByText("Loxel is your default web browser")).toBeDefined();
  });

  test("can't be set from a build that isn't the installed app", async () => {
    onMac({ getDefaultBrowserStatus: async () => ({ isDefault: false, canSet: false }) });
    renderSection();

    expect(
      await screen.findByText(/only the installed app can be the default browser/),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Set as default browser" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  test("is not offered outside macOS", () => {
    window.electronAPI = stubElectronAPI();
    renderSection();
    expect(screen.queryByText("Default Browser")).toBeNull();
  });
});

describe("GeneralSection update that restarts terminals", () => {
  const ready: UpdateState = { state: "ready", version: "1.2.0", restartsTerminals: true };

  test("warns, and installs only once the user confirms, naming the programs running", async () => {
    running = [terminal("claude"), terminal(null)];
    inDesktopApp(ready);
    renderSection();
    expect(await screen.findByText("This update restarts 2 terminals")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Install & Restart" }));
    await waitFor(() => openDialog());
    expect(within(openDialog()).getByText("claude")).toBeTruthy();
    fireEvent.click(within(openDialog()).getByRole("button", { name: "Cancel" }));
    expect(installUpdate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Install & Restart" }));
    await waitFor(() => openDialog());
    fireEvent.click(within(openDialog()).getByRole("button", { name: "Install & Restart" }));
    await waitFor(() => expect(installUpdate).toHaveBeenCalledTimes(1));
  });

  test("installs at once when no terminal is running", async () => {
    inDesktopApp(ready);
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Install & Restart" }));
    await waitFor(() => expect(installUpdate).toHaveBeenCalledTimes(1));
    expect(document.querySelector("dialog[open]")).toBeNull();
  });

  test("an update that keeps the terminals installs without asking or warning", async () => {
    running = [terminal("claude")];
    inDesktopApp({ state: "ready", version: "1.0.1", restartsTerminals: false });
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Install & Restart" }));
    await waitFor(() => expect(installUpdate).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/This update/)).toBeNull();
  });
});
