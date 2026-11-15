import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, render } from "@testing-library/react";
import type { editor } from "monaco-editor";
import type { RefObject } from "react";
import { useEffect } from "react";

import { useMonacoSyncScroll } from "./useMonacoSyncScroll";

afterEach(cleanup);

/** The slice of a Monaco editor the hook drives, recording horizontal scroll. */
function fakeEditor() {
  let scrollLeft = 0;
  return {
    getScrollTop: () => 0,
    setScrollTop: () => {},
    getScrollLeft: () => scrollLeft,
    setScrollLeft: (value: number) => {
      scrollLeft = value;
    },
    onDidScrollChange: () => ({ dispose: () => {} }),
    hasTextFocus: () => false,
  };
}

type FakeEditor = ReturnType<typeof fakeEditor>;

/** Mirrors SideBySideDiffView: the panel containers only render once content has loaded. */
function Harness({
  loaded,
  left,
  right,
  onLeftContainerRef,
}: {
  loaded: boolean;
  left: FakeEditor;
  right: FakeEditor;
  /** Receives the hook's RefObject for the left container, which DiffGutter reads sizes from. */
  onLeftContainerRef?: (ref: RefObject<HTMLDivElement | null>) => void;
}) {
  const { leftContainer, rightContainer, leftContainerRef, onLeftEditorMount, onRightEditorMount } =
    useMonacoSyncScroll({ alignmentSections: [], lineHeight: 18 });
  onLeftContainerRef?.(leftContainerRef);

  useEffect(() => {
    if (!loaded) return;
    // The fakes implement only what the hook calls.
    onLeftEditorMount(left as unknown as editor.IStandaloneCodeEditor);
    onRightEditorMount(right as unknown as editor.IStandaloneCodeEditor);
  }, [loaded, left, right, onLeftEditorMount, onRightEditorMount]);

  if (!loaded) return <div>Loading</div>;
  return (
    <>
      <div ref={leftContainer} data-testid="left" />
      <div ref={rightContainer} data-testid="right" />
    </>
  );
}

function wheel(target: Element, deltaX: number) {
  const event = new WheelEvent("wheel", { deltaX, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

describe("useMonacoSyncScroll", () => {
  test("scrolls both editors from containers that mount after the hook", () => {
    const left = fakeEditor();
    const right = fakeEditor();
    const { rerender, getByTestId } = render(<Harness loaded={false} left={left} right={right} />);
    rerender(<Harness loaded left={left} right={right} />);

    const event = wheel(getByTestId("right"), 40);

    expect(event.defaultPrevented).toBe(true);
    expect(left.getScrollLeft()).toBe(40);
    expect(right.getScrollLeft()).toBe(40);
  });

  test("stops intercepting wheel events once the containers unmount", () => {
    const left = fakeEditor();
    const right = fakeEditor();
    const { rerender, getByTestId } = render(<Harness loaded left={left} right={right} />);
    const container = getByTestId("left");
    rerender(<Harness loaded={false} left={left} right={right} />);

    const event = wheel(container, 40);

    expect(event.defaultPrevented).toBe(false);
    expect(left.getScrollLeft()).toBe(0);
  });

  test("exposes the mounted container for size reads, and clears it on unmount", () => {
    const left = fakeEditor();
    const right = fakeEditor();
    let containerRef: RefObject<HTMLDivElement | null> | undefined;
    const capture = (ref: RefObject<HTMLDivElement | null>) => {
      containerRef = ref;
    };
    const { rerender, getByTestId } = render(
      <Harness loaded left={left} right={right} onLeftContainerRef={capture} />,
    );
    expect<HTMLElement | null | undefined>(containerRef?.current).toBe(getByTestId("left"));

    rerender(<Harness loaded={false} left={left} right={right} onLeftContainerRef={capture} />);
    expect(containerRef?.current).toBeNull();
  });
});
