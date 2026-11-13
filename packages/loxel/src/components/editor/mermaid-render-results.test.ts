import { describe, expect, test } from "bun:test";

import {
  mermaidRenderFailed,
  onMermaidRenderResult,
  recordMermaidRender,
} from "./mermaid-render-results";

describe("mermaid render results", () => {
  test("records failures, and a success clears one", () => {
    expect(mermaidRenderFailed("graph TD\n  A -->")).toBe(false);
    recordMermaidRender("graph TD\n  A -->", false);
    expect(mermaidRenderFailed("graph TD\n  A -->")).toBe(true);
    recordMermaidRender("graph TD\n  A -->", true);
    expect(mermaidRenderFailed("graph TD\n  A -->")).toBe(false);
  });

  test("tells listeners only when a source's result changes", () => {
    let calls = 0;
    const unsubscribe = onMermaidRenderResult(() => {
      calls += 1;
    });
    recordMermaidRender("x -->", false);
    recordMermaidRender("x -->", false);
    recordMermaidRender("x -->", true);
    recordMermaidRender("x -->", true);
    unsubscribe();
    recordMermaidRender("x -->", false);
    expect(calls).toBe(2);
  });

  test("a failure that is still read outlives newer ones", () => {
    recordMermaidRender("kept -->", false);
    for (let i = 0; i < 5000; i++) {
      recordMermaidRender(`typed ${i} -->`, false);
      // An editor recomputing reads the blocks still in its document.
      if (i % 100 === 0) expect(mermaidRenderFailed("kept -->")).toBe(true);
    }
    expect(mermaidRenderFailed("kept -->")).toBe(true);
    expect(mermaidRenderFailed("typed 0 -->")).toBe(false);
  });
});
