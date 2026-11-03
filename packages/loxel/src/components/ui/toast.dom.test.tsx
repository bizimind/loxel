import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";

import { act, fireEvent, render, screen } from "@testing-library/react";

import { ToastContainer, showToast } from "./toast";

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  // Let every toast a test left up time out, so the next test starts with none.
  act(() => jest.runAllTimers());
  jest.useRealTimers();
});

describe("toasts", () => {
  test("an error keeps its line breaks and is closed with its dismiss button", () => {
    render(<ToastContainer />);
    act(() => showToast("wt remove failed\nhook exited with code 1"));

    const toast = screen.getByRole("alert");
    expect(toast.textContent).toBe("wt remove failed\nhook exited with code 1");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("closes on its own after a few seconds", () => {
    render(<ToastContainer />);
    act(() => showToast("Saved elsewhere", "info"));

    expect(screen.getByRole("status")).toBeDefined();
    act(() => jest.advanceTimersByTime(5_000));
    expect(screen.queryByRole("status")).toBeNull();
  });

  test("stays up while hovered and closes after the pointer leaves", () => {
    render(<ToastContainer />);
    act(() => showToast("A long error to read"));
    const toast = screen.getByRole("alert");

    fireEvent.mouseEnter(toast);
    act(() => jest.advanceTimersByTime(60_000));
    expect(screen.getByRole("alert")).toBe(toast);

    fireEvent.mouseLeave(toast);
    act(() => jest.advanceTimersByTime(5_000));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("stays up while its dismiss button has keyboard focus", () => {
    render(<ToastContainer />);
    act(() => showToast("Read with a keyboard"));
    const dismiss = screen.getByRole("button", { name: "Dismiss" });

    act(() => dismiss.focus());
    act(() => jest.advanceTimersByTime(60_000));
    expect(screen.getByRole("alert")).toBeDefined();

    act(() => dismiss.blur());
    act(() => jest.advanceTimersByTime(5_000));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("shows a toast raised before the container mounted", () => {
    showToast("Raised early");
    render(<ToastContainer />);

    expect(screen.getByRole("alert").textContent).toBe("Raised early");
  });
});
