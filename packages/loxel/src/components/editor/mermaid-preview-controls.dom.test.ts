/**
 * Mermaid preview controls: delegated toolbar actions, zoom and pan on the canvas, and
 * click-to-open. happy-dom has no layout, so the viewport and canvas get fixed sizes.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  attachMermaidPreviewControls,
  MERMAID_CLASSES,
  mermaidToolbarHtml,
} from "./mermaid-preview-controls";

let root: HTMLElement;
let opened: Element[];
let detach: () => void;

function setSize(el: HTMLElement, sizes: Record<string, number>): void {
  for (const [key, value] of Object.entries(sizes)) {
    Object.defineProperty(el, key, { configurable: true, value });
  }
}

beforeEach(() => {
  root = document.createElement("div");
  root.innerHTML = `<div class="milkdown-code-block"><div class="preview">
    <div class="${MERMAID_CLASSES.diagram}">${mermaidToolbarHtml()}
      <div class="${MERMAID_CLASSES.viewport}"><div class="${MERMAID_CLASSES.canvas}">
        <div class="loxel-mermaid-light"><svg viewBox="0 0 1000 200"></svg></div>
      </div></div>
    </div>
  </div></div>
  <div class="loxel-mermaid-error">Mermaid error: Parse error</div>`;
  document.body.append(root);
  // A diagram twice as wide as its viewport, which is as tall as the canvas.
  setSize(viewport(), { clientWidth: 500, clientHeight: 100 });
  setSize(canvas(), { scrollWidth: 1000, scrollHeight: 100 });
  opened = [];
  detach = attachMermaidPreviewControls(root, (codeBlock) => opened.push(codeBlock));
});

afterEach(() => {
  detach();
  root.remove();
});

const viewport = () => root.querySelector<HTMLElement>(`.${MERMAID_CLASSES.viewport}`)!;
const canvas = () => root.querySelector<HTMLElement>(`.${MERMAID_CLASSES.canvas}`)!;
const action = (name: string) =>
  root.querySelector<HTMLButtonElement>(`[data-mermaid-action="${name}"]`)!;

function mouse(target: EventTarget, type: string, x: number, y = 0): MouseEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: x,
    clientY: y,
  });
  target.dispatchEvent(event);
  return event;
}

function wheel(init: WheelEventInit): WheelEvent {
  canvas().dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
  const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
  // happy-dom's WheelEvent drops the modifier keys and pointer position of its init.
  for (const key of ["ctrlKey", "clientX", "clientY"] as const) {
    Object.defineProperty(event, key, { value: init[key] ?? (key === "ctrlKey" ? false : 0) });
  }
  canvas().dispatchEvent(event);
  return event;
}

describe("mermaid preview controls", () => {
  test("Open and a click on the diagram open the viewer with the code block", () => {
    action("open").click();
    mouse(canvas(), "mousedown", 10);
    mouse(window, "mouseup", 10);
    mouse(canvas(), "click", 10);
    const codeBlock = root.querySelector(".milkdown-code-block");
    expect(opened).toEqual([codeBlock!, codeBlock!]);
  });

  test("a drag pans the canvas, within its bounds, and does not open the viewer", () => {
    const down = mouse(canvas(), "mousedown", 300);
    expect(down.defaultPrevented).toBe(true); // ProseMirror must not start a selection
    mouse(window, "mousemove", 200);
    expect(canvas().style.transform).toBe("translate(-100px, 0px) scale(1)");
    mouse(window, "mousemove", -900);
    expect(canvas().style.transform).toBe("translate(-500px, 0px) scale(1)");
    mouse(window, "mouseup", -900);
    mouse(canvas(), "click", -900);
    expect(opened).toEqual([]);
  });

  test("zoom buttons zoom about the center, stop at the fitted width, and reset", () => {
    action("zoom-in").click();
    expect(canvas().style.transform).toBe("translate(-50px, -10px) scale(1.2)");
    for (let i = 0; i < 5; i += 1) action("zoom-out").click();
    const [x, y, scale] = (canvas().style.transform.match(/-?[\d.]+/g) ?? []).map(Number);
    expect([x, scale]).toEqual([0, 0.5]);
    expect(y).toBeCloseTo(25);
    action("reset").click();
    expect(canvas().style.transform).toBe("");
    expect(opened).toEqual([]);
  });

  test("pinch zooms and horizontal wheel pans; a vertical wheel scrolls the document", () => {
    const pinch = wheel({ deltaY: -100, ctrlKey: true, clientX: 0, clientY: 0 });
    expect(pinch.defaultPrevented).toBe(true);
    expect(canvas().style.transform).toBe("translate(0px, 0px) scale(2)");
    const sideways = wheel({ deltaX: 40, deltaY: 5 });
    expect(sideways.defaultPrevented).toBe(true);
    expect(canvas().style.transform).toBe("translate(-40px, 0px) scale(2)");
    const vertical = wheel({ deltaY: 40 });
    expect(vertical.defaultPrevented).toBe(false);
    expect(canvas().style.transform).toBe("translate(-40px, 0px) scale(2)");
  });

  test("an error preview and the rest of the editor are left alone", () => {
    const error = root.querySelector(".loxel-mermaid-error")!;
    expect(mouse(error, "mousedown", 0).defaultPrevented).toBe(false);
    mouse(error, "click", 0);
    expect(opened).toEqual([]);
  });

  test("detaching removes the listeners", () => {
    detach();
    action("open").click();
    expect(opened).toEqual([]);
    detach = () => {};
  });
});
