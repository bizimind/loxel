import { afterEach, describe, expect, test } from "bun:test";

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";

import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "./context-menu";

function Harness({
  initiallyOpen = true,
  onFirst,
}: {
  initiallyOpen?: boolean;
  onFirst?: () => void;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Target
      </button>
      <input aria-label="Elsewhere" />
      <span data-testid="state">{open ? "open" : "closed"}</span>
      <ContextMenu open={open} onOpenChange={setOpen} position={{ x: 10, y: 10 }}>
        <ContextMenuItem onClick={onFirst}>First</ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger>More</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem>Nested</ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
      </ContextMenu>
    </>
  );
}

const getAnimationsDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "getAnimations");
afterEach(() => {
  if (getAnimationsDescriptor) {
    Object.defineProperty(Element.prototype, "getAnimations", getAnimationsDescriptor);
  } else {
    Reflect.deleteProperty(Element.prototype, "getAnimations");
  }
});

/** Make Base UI wait for a real exit animation before unmounting, like the 100ms CSS one. */
function simulateExitAnimation(ms: number) {
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [{ finished: Bun.sleep(ms) }],
  });
}

describe("ContextMenu", () => {
  test("opening a submenu keeps the context menu open", async () => {
    render(<Harness />);
    fireEvent.click(await screen.findByText("More"));

    expect(await screen.findByText("Nested")).toBeTruthy();
    expect(screen.getByTestId("state").textContent).toBe("open");
    expect(screen.getByText("First")).toBeTruthy();
  });

  test("returns focus to the element that was focused when it opened", async () => {
    render(<Harness initiallyOpen={false} />);
    const target = screen.getByText("Target");
    target.focus();
    fireEvent.click(target);
    const menu = await screen.findByRole("menu");

    fireEvent.keyDown(menu, { key: "Escape" });

    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("closed"));
    await waitFor(() => expect(document.activeElement).toBe(target));
  });

  test("does not pull focus back from where a menu action moved it", async () => {
    simulateExitAnimation(100);
    render(
      <Harness
        initiallyOpen={false}
        onFirst={() => setTimeout(() => screen.getByLabelText("Elsewhere").focus(), 20)}
      />,
    );
    const target = screen.getByText("Target");
    target.focus();
    fireEvent.click(target);
    fireEvent.click(await screen.findByText("First"));

    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("closed"));
    await Bun.sleep(200);
    expect(document.activeElement).toBe(screen.getByLabelText("Elsewhere"));
  });
});
