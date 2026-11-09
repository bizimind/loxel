/**
 * Diff fence previews: the rendered view, the Unified/Split toggle in a live Crepe editor, and
 * that a preview never changes the saved markdown.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { Crepe } from "@milkdown/crepe";
import { editorViewCtx, remarkStringifyOptionsCtx } from "@milkdown/kit/core";

import type { PreviewValue } from "@/components/editor/code-block-preview";
import { useUIStore } from "@/store/ui";

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

const { renderCodeBlockPreview } = await import("./code-block-preview");
const { handleDiffBlockClick } = await import("./diff-block-preview");
const { serializeBody, setSourceBaseline } = await import("./MarkdownEditor");

const GIT_DIFF = [
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -3,3 +3,3 @@ export function app() {",
  "   const port = 80;",
  "-  listen(port);",
  "+  listen(port, host);",
  "   return port;",
].join("\n");

/** Runs the preview hook, which renders synchronously. */
function renderPreview(language: string, content: string): PreviewValue {
  const result = renderCodeBlockPreview(language, content, () => {
    throw new Error("diff previews render synchronously");
  });
  if (result === undefined) throw new Error("expected a synchronous preview");
  return result;
}

function parse(html: PreviewValue): HTMLElement {
  if (typeof html !== "string") throw new Error("expected HTML");
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
}

/** Resolves once `predicate` holds for the DOM under `root`, checking after every mutation. */
function waitFor(root: HTMLElement, predicate: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (predicate()) {
      resolve();
      return;
    }
    const observer = new MutationObserver(() => {
      if (!predicate()) return;
      observer.disconnect();
      resolve();
    });
    observer.observe(root, { childList: true, subtree: true });
  });
}

describe("renderDiffPreview", () => {
  test("routes diff and patch fences, in any case, to the diff view", () => {
    for (const language of ["diff", "patch", "Diff"]) {
      const view = parse(renderPreview(language, GIT_DIFF));
      expect(view.querySelector(".loxel-diff-block")).not.toBeNull();
    }
    expect(renderCodeBlockPreview("typescript", GIT_DIFF, () => {})).toBeNull();
  });

  test("renders both layouts with file header, line numbers and change coloring", () => {
    const view = parse(renderPreview("diff", GIT_DIFF));
    expect(view.textContent).toContain("src/app.ts");
    expect(view.textContent).toContain("@@ -3,3 +3,3 @@ export function app() {");

    const unified = view.querySelector('[data-diff-view="unified"]')!;
    const split = view.querySelector('[data-diff-view="split"]')!;
    expect(unified.querySelectorAll("tr")).toHaveLength(4);
    expect(unified.querySelector("tr.diff-line-del")?.textContent).toContain("4");
    expect(unified.querySelector("tr.diff-line-add")?.textContent).toContain("listen(port, host);");
    // Split pairs the removed line with the added one on the same row.
    const [left, right] = split.querySelectorAll("table");
    expect(left!.querySelectorAll("tr")).toHaveLength(3);
    expect(right!.querySelectorAll("tr")).toHaveLength(3);
    // Intra-line highlight of the changed part.
    expect(view.querySelector(".diff-inline-add")?.textContent).toContain("host");

    const options = [...view.querySelectorAll("[data-diff-view-mode-option]")];
    expect(options.map((b) => b.getAttribute("data-diff-view-mode-option"))).toEqual([
      "unified",
      "split",
    ]);
  });

  test("renders a headerless snippet without file header or line numbers", () => {
    const view = parse(renderPreview("diff", "-old line\n+new line\n"));
    expect(view.querySelector("img")).toBeNull();
    const cells = [...view.querySelectorAll('[data-diff-view="unified"] tr td:first-child')];
    expect(cells.map((td) => td.textContent)).toEqual(["", ""]);
    expect(view.querySelector('[data-diff-view="unified"] tr.diff-line-add')).not.toBeNull();
  });

  test("falls back to the plain code block when the text holds no diff", () => {
    expect(renderPreview("diff", "")).toBeNull();
    expect(renderPreview("diff", "not a diff at all")).toBeNull();
  });

  test("escapes diff content instead of parsing it as HTML", () => {
    const view = parse(renderPreview("diff", '+<img src=x onerror="alert(1)">\n'));
    expect(view.querySelector("img[onerror]")).toBeNull();
    expect(view.textContent).toContain('<img src=x onerror="alert(1)">');
  });
});

describe("diff fences in the editor", () => {
  let root: HTMLDivElement;
  let crepe: Crepe;

  async function mount(source: string): Promise<void> {
    root = document.createElement("div");
    document.body.appendChild(root);
    crepe = new Crepe({
      root,
      defaultValue: source,
      features: { [Crepe.Feature.Latex]: false },
      featureConfigs: { [Crepe.Feature.CodeMirror]: { renderPreview: renderCodeBlockPreview } },
    });
    // Mirror the component's stringify config so canonical forms match production.
    crepe.editor.config((ctx) => {
      ctx.set(remarkStringifyOptionsCtx, {
        ...ctx.get(remarkStringifyOptionsCtx),
        bullet: "-",
        rule: "-",
      });
    });
    await crepe.create();
  }

  beforeEach(() => {
    useUIStore.getState().setDiffViewMode("unified");
  });

  afterEach(async () => {
    await crepe.destroy();
    root.remove();
  });

  test("the Unified/Split buttons survive the panel's sanitizer and set the view mode", async () => {
    await mount(`Intro\n\n\`\`\`diff\n${GIT_DIFF}\n\`\`\`\n`);
    // The component delegates clicks from the editor container to handleDiffBlockClick.
    root.addEventListener("click", handleDiffBlockClick);

    const splitButton = '.preview [data-diff-view-mode-option="split"]';
    await waitFor(root, () => root.querySelector(splitButton) !== null);
    root.querySelector<HTMLElement>(splitButton)!.click();
    expect(useUIStore.getState().diffViewMode).toBe("split");

    root.querySelector<HTMLElement>('[data-diff-view-mode-option="unified"]')!.click();
    expect(useUIStore.getState().diffViewMode).toBe("unified");

    // A click elsewhere in the block leaves the setting alone.
    root.querySelector<HTMLElement>(".preview tr")!.click();
    expect(useUIStore.getState().diffViewMode).toBe("unified");
  });

  test("untouched diff fences save byte-identically with their previews rendered", async () => {
    // Non-canonical fences: the serializer alone would rewrite them as ``` fences.
    const source = [
      "Intro",
      "",
      "~~~ diff",
      "-a",
      "+b",
      "~~~",
      "",
      "````Patch",
      GIT_DIFF,
      "````",
      "",
    ].join("\n");
    await mount(source);
    const toggles = '.preview [data-diff-view-mode-option="split"]';
    await waitFor(root, () => root.querySelectorAll(toggles).length === 2);
    expect(crepe.getMarkdown()).not.toBe(source);
    setSourceBaseline(crepe, source);
    expect(serializeBody(crepe)).toBe(source);

    // Editing another block rewrites only that block.
    crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr.insertText(" edited", 6));
    });
    expect(serializeBody(crepe)).toBe(source.replace("Intro", "Intro edited"));
  });
});
