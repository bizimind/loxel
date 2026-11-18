import { describe, expect, jest, test } from "bun:test";

import { fireEvent, render, screen } from "@testing-library/react";

import { DraggablePanelHeader } from "@/components/panels/DraggablePanelHeader";

function renderHeader() {
  render(
    <DraggablePanelHeader panelId="logs">
      <span>Logs</span>
      <button title="Clear logs">
        <svg data-testid="clear-icon" />
      </button>
      <input aria-label="Filter" />
    </DraggablePanelHeader>,
  );
  const header = screen.getByText("Logs").parentElement;
  if (!header) throw new Error("header not rendered");
  return header;
}

/**
 * Press on `pressed`, then start a drag the way the browser does: on the draggable header, whatever
 * descendant the press was on. Returns whether the drag went ahead and what it carried.
 */
function pressAndDrag(header: HTMLElement, pressed: Element) {
  const setData = jest.fn();
  fireEvent.pointerDown(pressed);
  const proceeded = fireEvent.dragStart(header, {
    dataTransfer: { setData, setDragImage: jest.fn(), effectAllowed: "none" },
  });
  return { proceeded, setData };
}

describe("DraggablePanelHeader", () => {
  test("a drag from the header itself drags the panel", () => {
    const header = renderHeader();

    const { proceeded, setData } = pressAndDrag(header, screen.getByText("Logs"));

    expect(proceeded).toBe(true);
    expect(setData).toHaveBeenCalledWith("text/plain", "logs");
  });

  test.each([
    ["a button", () => screen.getByTitle("Clear logs")],
    ["an icon inside a button", () => screen.getByTestId("clear-icon")],
    ["a text field", () => screen.getByLabelText("Filter")],
  ])("a drag that starts on %s does not drag the panel", (_name, control) => {
    const header = renderHeader();

    const { proceeded, setData } = pressAndDrag(header, control());

    expect(proceeded).toBe(false);
    expect(setData).not.toHaveBeenCalled();
  });

  test("a drag of a descendant's own content, like selected text in a field, is left alone", () => {
    renderHeader();
    const field = screen.getByLabelText("Filter");
    const setData = jest.fn();

    fireEvent.pointerDown(field);
    const proceeded = fireEvent.dragStart(field, {
      dataTransfer: { setData, setDragImage: jest.fn(), effectAllowed: "none" },
    });

    expect(proceeded).toBe(true);
    expect(setData).not.toHaveBeenCalled();
  });

  test("a press on the header after one on a control drags the panel again", () => {
    const header = renderHeader();
    pressAndDrag(header, screen.getByTitle("Clear logs"));

    const { proceeded, setData } = pressAndDrag(header, screen.getByText("Logs"));

    expect(proceeded).toBe(true);
    expect(setData).toHaveBeenCalledWith("text/plain", "logs");
  });
});
