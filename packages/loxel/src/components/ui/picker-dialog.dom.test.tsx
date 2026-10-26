import { describe, expect, mock, test } from "bun:test";

import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";

import { PickerDialog, PickerMessage } from "./picker-dialog";

const noop = () => {};

function Harness({
  items,
  onAccept,
  onSubmitQuery,
  onClose = noop,
  isOpen = true,
}: {
  items: string[];
  onAccept: (item: string) => void;
  onSubmitQuery?: (query: string) => void;
  onClose?: () => void;
  isOpen?: boolean;
}) {
  const [query, setQuery] = useState("");
  return (
    <PickerDialog
      name="Test"
      isOpen={isOpen}
      onClose={onClose}
      onSubmitQuery={onSubmitQuery}
      query={query}
      onQueryChange={setQuery}
      placeholder="Pick"
      items={items}
      getKey={(item) => item}
      renderItem={(item) => item}
      onAccept={onAccept}
      emptyState={<PickerMessage>Nothing</PickerMessage>}
    />
  );
}

function setup(items = ["alpha", "beta", "gamma"]) {
  const onAccept = mock((_item: string) => {});
  const { rerender } = render(<Harness items={items} onAccept={onAccept} />);
  const input = screen.getByPlaceholderText("Pick");
  input.focus();
  return {
    onAccept,
    input,
    option: (name: string) => screen.getByRole("button", { name }),
    setItems: (next: string[]) => rerender(<Harness items={next} onAccept={onAccept} />),
  };
}

describe("PickerDialog", () => {
  test("Enter in the input accepts the first item", () => {
    const { onAccept, input } = setup();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onAccept).toHaveBeenCalledWith("alpha");
  });

  test("arrow keys move through the items and back to the input", () => {
    const { input, option } = setup();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(document.activeElement).toBe(option("alpha"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(option("gamma"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(input);
  });

  test("Enter on a focused item accepts that item", () => {
    const { onAccept, input } = setup();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(onAccept).toHaveBeenCalledWith("beta");
  });

  test("items that stream in keep a still-listed item focused", () => {
    const { input, option, setItems, onAccept } = setup();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    setItems(["alpha", "beta", "gamma", "delta"]);
    expect(document.activeElement).toBe(option("beta"));
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(onAccept).toHaveBeenCalledWith("beta");
  });

  test("an unmounted focused item hands focus to the first item", () => {
    const { input, option, setItems } = setup();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    setItems(["alpha", "gamma"]);
    expect(document.activeElement).toBe(option("alpha"));
  });

  test("typing while an item is focused edits the query", () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: "ab" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement!, { key: "c" });
    expect(input).toHaveValue("abc");
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement!, { key: "Backspace" });
    expect(input).toHaveValue("ab");
  });

  test("Enter submits the trimmed query in input mode", () => {
    const onSubmitQuery = mock((_query: string) => {});
    render(<Harness items={[]} onAccept={() => {}} onSubmitQuery={onSubmitQuery} />);
    const input = screen.getByPlaceholderText("Pick");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmitQuery).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "  ~/venv/bin/python " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmitQuery).toHaveBeenCalledWith("~/venv/bin/python");
  });

  test("closing through isOpen is not reported as a dismissal", () => {
    const onClose = mock(() => {});
    const { rerender } = render(<Harness items={["a"]} onAccept={() => {}} onClose={onClose} />);
    // The close event follows `dialog.close()` (synchronously in happy-dom, a task later in browsers).
    rerender(<Harness items={["a"]} onAccept={() => {}} onClose={onClose} isOpen={false} />);
    expect(onClose).not.toHaveBeenCalled();
    // A close the user makes (Escape) still dismisses.
    rerender(<Harness items={["a"]} onAccept={() => {}} onClose={onClose} />);
    fireEvent(document.querySelector("dialog")!, new Event("close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("shows the empty state without items", () => {
    const { onAccept, input } = setup([]);
    expect(screen.getByText("Nothing")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onAccept).not.toHaveBeenCalled();
  });
});
