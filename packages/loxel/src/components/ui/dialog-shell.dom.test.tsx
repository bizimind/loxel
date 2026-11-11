import { expect, mock, test } from "bun:test";

import { fireEvent, render } from "@testing-library/react";

import { DialogShell } from "./dialog-shell";

function renderShell() {
  const onCancel = mock(() => {});
  const { container } = render(
    <DialogShell open={false} onCancel={onCancel}>
      <div data-testid="body">content</div>
    </DialogShell>,
  );
  const dialog = container.querySelector("dialog")!;
  return { onCancel, dialog, body: container.querySelector("[data-testid=body]")! };
}

test("a click on the backdrop closes the dialog", () => {
  const { onCancel, dialog } = renderShell();
  fireEvent.mouseDown(dialog);
  fireEvent.click(dialog);
  expect(onCancel).toHaveBeenCalledTimes(1);
});

test("a drag from inside the dialog that ends on the backdrop keeps it open", () => {
  const { onCancel, dialog, body } = renderShell();
  fireEvent.mouseDown(body);
  // The click goes to the common ancestor of the press and the release: the dialog.
  fireEvent.click(dialog);
  expect(onCancel).not.toHaveBeenCalled();
});
