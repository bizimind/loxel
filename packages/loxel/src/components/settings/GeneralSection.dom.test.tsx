import { beforeEach, describe, expect, jest, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";

const originalClient = await import("@/api/client");
mock.module("@/api/client", () => ({
  ...originalClient,
  checkForUpdate: jest.fn(async () => ({ state: "idle" })),
  getUpdateStatus: jest.fn(async () => ({ state: "idle" })),
  getVersion: jest.fn(async () => ({ version: "1.0.0", isDev: false })),
  putStore: jest.fn(async () => ({ success: true })),
}));

const api = await import("@/api/client");
const { GeneralSection } = await import("./GeneralSection");
const { useSettingsStore } = await import("@/store/settings-store");

function renderSection() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <GeneralSection />
    </QueryClientProvider>,
  );
  const row = screen.getByText("Check for updates automatically").parentElement;
  const toggle = row?.querySelector('[role="switch"]');
  if (!(toggle instanceof HTMLElement)) throw new Error("Automatic check switch not found");
  return toggle;
}

describe("GeneralSection automatic update check", () => {
  beforeEach(() => {
    useSettingsStore.setState({ autoCheckForUpdates: true });
  });

  test("is on by default", () => {
    expect(useSettingsStore.getInitialState().autoCheckForUpdates).toBe(true);
  });

  test("the switch turns it off and on", () => {
    const toggle = renderSection();
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(toggle);
    expect(useSettingsStore.getState().autoCheckForUpdates).toBe(false);
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(toggle);
    expect(useSettingsStore.getState().autoCheckForUpdates).toBe(true);
  });

  test("the manual check stays available when it is off", () => {
    useSettingsStore.setState({ autoCheckForUpdates: false });
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(api.checkForUpdate).toHaveBeenCalledTimes(1);
  });
});
