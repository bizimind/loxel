import { afterEach, beforeAll, describe, expect, jest, mock, test } from "bun:test";

import { act, cleanup, render } from "@testing-library/react";

const originalClient = await import("@/api/client");
mock.module("@/api/client", () => ({
  ...originalClient,
  getStore: jest.fn(async () => null),
  putStore: jest.fn(async () => ({ success: true })),
}));

const { useSettingsStore } = await import("@/store/settings-store");
const { useUIStore } = await import("@/store/ui");
const { useThemeSync } = await import("./useThemeSync");

/** A `prefers-color-scheme: dark` query whose answer the test sets. */
const systemScheme = {
  matches: false,
  listeners: new Set<() => void>(),
  set(dark: boolean) {
    this.matches = dark;
    for (const listener of this.listeners) listener();
  },
};

beforeAll(async () => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      get matches() {
        return systemScheme.matches;
      },
      addEventListener: (_type: string, listener: () => void) =>
        systemScheme.listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) =>
        systemScheme.listeners.delete(listener),
    }),
  });
  await useSettingsStore.persist.rehydrate();
});

afterEach(() => {
  cleanup();
  systemScheme.set(false);
  useSettingsStore.setState({ theme: "dark" });
});

function Harness() {
  useThemeSync();
  return null;
}

function applied() {
  const root = document.documentElement;
  return {
    darkClass: root.classList.contains("dark"),
    colorScheme: root.style.colorScheme,
    darkMode: useUIStore.getState().darkMode,
    cached: localStorage.getItem("loxel-dark-mode"),
  };
}

describe("useThemeSync", () => {
  test("dark", () => {
    useSettingsStore.setState({ theme: "dark" });
    render(<Harness />);
    expect(applied()).toEqual({
      darkClass: true,
      colorScheme: "dark",
      darkMode: true,
      cached: "true",
    });
  });

  test("light", () => {
    useSettingsStore.setState({ theme: "light" });
    render(<Harness />);
    expect(applied()).toEqual({
      darkClass: false,
      colorScheme: "light",
      darkMode: false,
      cached: "false",
    });
  });

  test("system follows the OS, including when it changes", () => {
    useSettingsStore.setState({ theme: "system" });
    render(<Harness />);
    expect(applied().darkMode).toBe(false);
    expect(applied().darkClass).toBe(false);

    act(() => systemScheme.set(true));
    expect(applied()).toEqual({
      darkClass: true,
      colorScheme: "dark",
      darkMode: true,
      cached: "true",
    });
  });

  test("switching the setting applies at once", () => {
    useSettingsStore.setState({ theme: "dark" });
    render(<Harness />);
    act(() => useSettingsStore.setState({ theme: "light" }));
    expect(applied().darkClass).toBe(false);
    expect(useUIStore.getState().darkMode).toBe(false);
  });
});
