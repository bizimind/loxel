import { afterEach, describe, expect, mock, test } from "bun:test";

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useRef } from "react";

import { FindBar } from "@/components/ui/find-bar";
import type { FindMatches } from "@/components/ui/find-bar";
import { getFocusedFindTarget } from "@/lib/find-targets";

import type { FindBackend } from "./usePanelFind";
import { usePanelFind } from "./usePanelFind";

function Harness({ backend, matches }: { backend: FindBackend; matches?: FindMatches }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const { barProps, setMatches } = usePanelFind(rootRef, backend);
  useEffect(() => {
    if (matches) setMatches(matches);
  }, [matches, setMatches]);
  return (
    <div ref={rootRef}>
      <button type="button">Content</button>
      {barProps && <FindBar label="Find in test" {...barProps} />}
    </div>
  );
}

function setup(matches?: FindMatches) {
  const backend = { find: mock(), clear: mock(), close: mock() };
  const view = render(<Harness backend={backend} matches={matches} />);
  screen.getByText("Content").focus();
  return { backend, view };
}

function focusedTarget() {
  const target = getFocusedFindTarget();
  if (!target) throw new Error("no find target holds focus");
  return target;
}

const input = () => screen.getByLabelText("Find in test");

afterEach(cleanup);

describe("usePanelFind", () => {
  test("registers the panel as a find target only while focus is inside it", () => {
    setup();
    expect(getFocusedFindTarget()).toBeDefined();
    (document.activeElement as HTMLElement).blur();
    expect(getFocusedFindTarget()).toBeUndefined();
  });

  test("open shows the bar with its input focused", () => {
    setup();
    expect(screen.queryByLabelText("Find in test")).toBeNull();
    act(() => focusedTarget().open());
    expect(document.activeElement).toBe(input());
  });

  test("typing searches the new query; Enter and ⇧Enter step through matches", () => {
    const { backend } = setup();
    act(() => focusedTarget().open());
    fireEvent.change(input(), { target: { value: "foo" } });
    expect(backend.find).toHaveBeenLastCalledWith("foo", "next", true);
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(backend.find).toHaveBeenLastCalledWith("foo", "next", false);
    fireEvent.keyDown(input(), { key: "Enter", shiftKey: true });
    expect(backend.find).toHaveBeenLastCalledWith("foo", "previous", false);
    act(() => focusedTarget().previous());
    expect(backend.find).toHaveBeenLastCalledWith("foo", "previous", false);
  });

  test("clearing the query clears highlights", () => {
    const { backend } = setup();
    act(() => focusedTarget().open());
    fireEvent.change(input(), { target: { value: "foo" } });
    fireEvent.change(input(), { target: { value: "" } });
    expect(backend.clear).toHaveBeenCalledTimes(1);
  });

  test("Escape closes the bar; reopening keeps the query and searches it again", () => {
    const { backend } = setup();
    act(() => focusedTarget().open());
    fireEvent.change(input(), { target: { value: "foo" } });
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(backend.close).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText("Find in test")).toBeNull();

    screen.getByText("Content").focus();
    backend.find.mockClear();
    act(() => focusedTarget().open());
    expect(input()).toHaveValue("foo");
    expect(backend.find).toHaveBeenCalledWith("foo", "next", true);
  });

  test("next with the bar closed opens it instead of searching", () => {
    const { backend } = setup();
    act(() => focusedTarget().next());
    expect(document.activeElement).toBe(input());
    expect(backend.find).not.toHaveBeenCalled();
  });

  test("shows the match position and count", () => {
    setup({ active: 2, total: 5 });
    act(() => focusedTarget().open());
    fireEvent.change(input(), { target: { value: "foo" } });
    expect(screen.getByText("2 of 5")).toBeInTheDocument();
  });

  test("shows when nothing matches", () => {
    setup({ active: 0, total: 0 });
    act(() => focusedTarget().open());
    fireEvent.change(input(), { target: { value: "zzz" } });
    expect(screen.getByText("No results")).toBeInTheDocument();
  });
});
