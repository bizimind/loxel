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

/** Start a drag the way the browser does once a press on the header moves: on the header itself. */
function dragHeader(header: HTMLElement) {
  const setData = jest.fn();
  const proceeded = fireEvent.dragStart(header, {
    dataTransfer: { setData, setDragImage: jest.fn(), effectAllowed: "none" },
  });
  return { proceeded, setData };
}

describe("DraggablePanelHeader", () => {
  test("a drag from the header itself drags the panel", () => {
    const header = renderHeader();
    expect(header.getAttribute("draggable")).toBe("true");

    fireEvent.pointerDown(screen.getByText("Logs"));

    expect(header.getAttribute("draggable")).toBe("true");
    const { proceeded, setData } = dragHeader(header);
    expect(proceeded).toBe(true);
    expect(setData).toHaveBeenCalledWith("text/plain", "logs");
  });

  // The header's dragging is suspended rather than its dragstart cancelled: a cancelled dragstart
  // gets no dragend, which would leave window-level drag tracking stuck.
  test.each([
    ["a button", () => screen.getByTitle("Clear logs")],
    ["an icon inside a button", () => screen.getByTestId("clear-icon")],
    ["a text field", () => screen.getByLabelText("Filter")],
  ])("a press on %s suspends the header's dragging", (_name, control) => {
    const header = renderHeader();

    fireEvent.pointerDown(control());

    expect(header.getAttribute("draggable")).toBe("false");
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
    fireEvent.pointerDown(screen.getByTitle("Clear logs"));

    fireEvent.pointerDown(screen.getByText("Logs"));

    expect(header.getAttribute("draggable")).toBe("true");
    expect(dragHeader(header).setData).toHaveBeenCalledWith("text/plain", "logs");
  });
});
