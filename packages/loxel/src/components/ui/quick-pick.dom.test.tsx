import { describe, expect, mock, test } from "bun:test";

import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";

import { QuickPick, QuickPickMessage } from "./quick-pick";

function Harness({ items, onAccept }: { items: string[]; onAccept: (item: string) => void }) {
  const [query, setQuery] = useState("");
  return (
    <QuickPick
      name="Test"
      isOpen
      onClose={() => {}}
      query={query}
      onQueryChange={setQuery}
      placeholder="Pick"
      items={items}
      getKey={(item) => item}
      renderItem={(item) => item}
      onAccept={onAccept}
      emptyState={<QuickPickMessage>Nothing</QuickPickMessage>}
    />
  );
}

function setup(items = ["alpha", "beta", "gamma"]) {
  const onAccept = mock((_item: string) => {});
  render(<Harness items={items} onAccept={onAccept} />);
  const input = screen.getByPlaceholderText("Pick");
  input.focus();
  return { onAccept, input, option: (name: string) => screen.getByRole("button", { name }) };
}

describe("QuickPick", () => {
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

  test("shows the empty state without items", () => {
    const { onAccept, input } = setup([]);
    expect(screen.getByText("Nothing")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onAccept).not.toHaveBeenCalled();
  });
});
