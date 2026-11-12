/**
 * Code block previews: which blocks get a preview, how mermaid is driven, and that a preview
 * never changes the saved markdown. Mermaid itself is mocked; happy-dom has no layout.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { Crepe } from "@milkdown/crepe";

interface RenderCall {
  id: string;
  source: string;
  config: Record<string, unknown>;
}

const renderCalls: RenderCall[] = [];
let currentConfig: Record<string, unknown> = {};
let renderImpl: (id: string, source: string) => Promise<{ svg: string }>;

function defaultRender(id: string, source: string): Promise<{ svg: string }> {
  return Promise.resolve({
    svg: `<svg id="${id}" viewBox="0 0 640 480"><text>${source.length}</text></svg>`,
  });
}

/** happy-dom never reports intersections; code blocks only mount once they are visible. */
class ImmediateIntersectionObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(target: Element): void {
    const entry = { target, isIntersecting: true };
    queueMicrotask(() => this.callback([entry as IntersectionObserverEntry], this as never));
  }
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.IntersectionObserver = ImmediateIntersectionObserver as never;

void mock.module("mermaid", () => ({
  default: {
    initialize: (config: Record<string, unknown>) => {
      currentConfig = config;
    },
    render: (id: string, source: string) => {
      renderCalls.push({ id, source, config: currentConfig });
      return renderImpl(id, source);
    },
  },
}));

const { renderCodeBlockPreview } = await import("./code-block-preview");
const { renderMermaidDiagram } = await import("./mermaid-preview");
const { serializeBody, setSourceBaseline } = await import("./MarkdownEditor");

type PreviewValue = string | HTMLElement | null;

function svgIds(preview: PreviewValue): string[] {
  if (typeof preview !== "string") throw new Error("expected an SVG preview");
  return [...preview.matchAll(/<svg id="([^"]+)"/g)].map((m) => m[1]!);
}

/** Runs the preview hook and resolves with the value it applies asynchronously. */
function renderAsync(language: string, content: string): Promise<PreviewValue> {
  return new Promise((resolve) => {
    const result = renderCodeBlockPreview(language, content, resolve);
    expect(result).toBeUndefined();
  });
}

beforeEach(() => {
  renderCalls.length = 0;
  renderImpl = defaultRender;
});

describe("renderCodeBlockPreview routing", () => {
  test("other languages get no preview", () => {
    for (const language of ["", "ts", "markdown", "mermaidjs", "constructor", "__proto__"]) {
      expect(renderCodeBlockPreview(language, "graph TD; A-->B", () => {})).toBeNull();
    }
    expect(renderCalls).toHaveLength(0);
  });

  test("empty mermaid blocks clear their preview without rendering", async () => {
    expect(await renderAsync("mermaid", "")).toBeNull();
    expect(await renderAsync("mermaid", "  \n\t\n")).toBeNull();
    expect(renderCalls).toHaveLength(0);
  });

  test("mermaid blocks render asynchronously, case-insensitively", async () => {
    const preview = await renderAsync("Mermaid", "graph LR; A-->B");
    expect(typeof preview).toBe("string");
    expect(renderCalls.map((c) => c.source)).toEqual(["graph LR; A-->B", "graph LR; A-->B"]);
  });
});

describe("mermaid rendering", () => {
  test("renders a light and a dark variant with strict security and unique ids", async () => {
    const preview = await renderAsync("mermaid", "graph TD; A-->B");
    expect(renderCalls.map((c) => c.config)).toEqual([
      {
        startOnLoad: false,
        securityLevel: "strict",
        suppressErrorRendering: true,
        theme: "default",
      },
      { startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true, theme: "dark" },
    ]);
    if (typeof preview !== "string") throw new Error("expected an SVG preview");
    const host = document.createElement("div");
    host.innerHTML = preview;
    const diagram = host.querySelector(":scope > .loxel-mermaid");
    if (!(diagram instanceof HTMLElement)) throw new Error("expected the diagram wrapper");
    // The natural width, from the viewBox, keeps CSS from shrinking it below a readable size.
    expect(diagram.style.getPropertyValue("--loxel-mermaid-width")).toBe("640px");
    const actions = [...diagram.querySelectorAll(".loxel-mermaid-toolbar [data-mermaid-action]")];
    expect(actions.map((b) => b.getAttribute("data-mermaid-action"))).toEqual([
      "edit",
      "hide",
      "zoom-out",
      "zoom-in",
      "reset",
      "copy-svg",
      "copy-png",
      "open",
    ]);
    const canvas = diagram.querySelector(
      ":scope > .loxel-mermaid-viewport > .loxel-mermaid-canvas",
    );
    const variants = [...(canvas?.children ?? [])].map((el) => el.className);
    expect(variants).toEqual(["loxel-mermaid-light", "loxel-mermaid-dark"]);
    expect(canvas?.querySelectorAll("svg text")[0]?.textContent).toBe("15");
    expect(new Set(svgIds(preview)).size).toBe(2);
  });

  test("a diagram rendered again comes from the cache under fresh ids", async () => {
    const first = await renderAsync("mermaid", "graph BT; A-->B");
    const second = await renderAsync("mermaid", "graph BT; A-->B");
    expect(renderCalls).toHaveLength(2);
    expect(second).not.toBe(first);
    expect(new Set([...svgIds(first), ...svgIds(second)]).size).toBe(4);
  });

  test("the full-size viewer reuses the preview's render, sanitized and with its size", async () => {
    renderImpl = (id) =>
      Promise.resolve({
        svg: `<svg id="${id}" viewBox="0 0 320 200"><script>alert(1)</script><text onclick="alert(2)">Hi</text></svg>`,
      });
    await renderAsync("mermaid", "graph LR; X-->Y");
    const diagram = await renderMermaidDiagram("graph LR; X-->Y");
    expect(renderCalls).toHaveLength(2);
    expect(diagram.size).toEqual({ width: 320, height: 200 });
    // happy-dom's DOMPurify also drops the root <svg> itself (Chromium keeps it), so only what
    // must be gone is checked here.
    for (const svg of [diagram.light, diagram.dark]) {
      expect(svg).not.toContain("<script");
      expect(svg).not.toContain("onclick");
    }
  });

  test("a parse error shows as plain text and the temp node is removed", async () => {
    renderImpl = (id) => {
      // Mermaid's temp container, left behind when rendering throws.
      const temp = document.createElement("div");
      temp.id = `d${id}`;
      document.body.appendChild(temp);
      return Promise.reject(new Error('Parse error: <img src="x" onerror="alert(1)">'));
    };
    const preview = await renderAsync("mermaid", "graph TD; A-->");
    if (!(preview instanceof HTMLElement)) throw new Error("expected an error element");
    expect(preview.textContent).toBe(
      'Mermaid error: Parse error: <img src="x" onerror="alert(1)">',
    );
    expect(preview.querySelector("img")).toBeNull();
    expect(renderCalls).toHaveLength(1); // the dark variant is skipped
    expect(document.getElementById(`d${renderCalls[0]!.id}`)).toBeNull();
  });

  test("renders run one at a time in request order", async () => {
    const pending: (() => void)[] = [];
    let active = 0;
    let maxActive = 0;
    let onStart = () => {};
    const nextStart = () =>
      new Promise<void>((resolve) => {
        onStart = resolve;
      });
    renderImpl = (id, source) =>
      new Promise((resolve) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        pending.push(() => {
          active -= 1;
          resolve({ svg: `<svg id="${id}">${source}</svg>` });
        });
        onStart();
      });
    const applied: string[] = [];
    const request = (source: string) =>
      new Promise<void>((resolve) => {
        renderCodeBlockPreview("mermaid", source, (value) => {
          if (typeof value === "string") applied.push(source);
          resolve();
        });
      });
    let started = nextStart();
    const settled = Promise.all([request("old"), request("new")]);
    // Two sources × two themes; each render is released only after it has started.
    for (let i = 0; i < 4; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- renders are released one by one
      await started;
      started = nextStart();
      pending.shift()?.();
    }
    await settled;
    expect(applied).toEqual(["old", "new"]);
    expect(maxActive).toBe(1);
  });
});

describe("source preservation", () => {
  let root: HTMLDivElement;
  let crepe: Crepe;

  afterEach(async () => {
    await crepe.destroy();
    root.remove();
  });

  test("an untouched mermaid fence saves byte-identically with its preview rendered", async () => {
    // Non-canonical fences: the serializer alone would rewrite them as ``` fences.
    const source = [
      "Intro",
      "",
      "~~~ mermaid",
      "graph TD",
      "    A[Start] --> B{Choice}",
      "~~~",
      "",
      "````Mermaid",
      "sequenceDiagram",
      "  Alice->>Bob: Hi",
      "````",
      "",
    ].join("\n");
    const diagrams: string[] = [];
    let onBothApplied = () => {};
    const bothApplied = new Promise<void>((resolve) => {
      onBothApplied = resolve;
    });
    root = document.createElement("div");
    document.body.appendChild(root);
    crepe = new Crepe({
      root,
      defaultValue: source,
      features: { [Crepe.Feature.Latex]: false },
      featureConfigs: {
        [Crepe.Feature.CodeMirror]: {
          renderPreview: (language, content, applyPreview) =>
            renderCodeBlockPreview(language, content, (value) => {
              applyPreview(value);
              if (typeof value === "string") diagrams.push(value);
              if (diagrams.length === 2) onBothApplied();
            }),
        },
      },
    });
    await crepe.create();
    await bothApplied;
    expect(crepe.getMarkdown()).not.toBe(source);
    setSourceBaseline(crepe, source);
    expect(serializeBody(crepe)).toBe(source);
  });
});
