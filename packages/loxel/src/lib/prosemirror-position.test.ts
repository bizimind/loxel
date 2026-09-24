import { describe, expect, it } from "bun:test";

import { Editor, defaultValueCtx, editorViewCtx, rootCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import type { Node as ProseMirrorNode } from "@milkdown/kit/prose/model";

import { localDbDirectivePlugins } from "@/components/editor/localdb-directive";

import { rawLineToProsePosition } from "./prosemirror-position";

async function parseDoc(markdown: string): Promise<ProseMirrorNode> {
  const editor = Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, document.createElement("div"));
      ctx.set(defaultValueCtx, markdown);
    })
    .use(commonmark)
    .use(gfm)
    .use(localDbDirectivePlugins);
  await editor.create();
  const doc = editor.action((ctx) => ctx.get(editorViewCtx).state.doc);
  await editor.destroy();
  return doc;
}

function textAt(doc: ProseMirrorNode, pos: number, length: number): string {
  return doc.textBetween(pos, pos + length);
}

describe("rawLineToProsePosition", () => {
  it("maps a line after a :::localdb block to the matching text node", async () => {
    const raw =
      "intro\n\n:::localdb\ntable: tasks\nview: table\n:::\n\nfirst after\n\nsecond after\n";
    const doc = await parseDoc(raw);

    const pos = rawLineToProsePosition(doc, 10, 1, raw);
    expect(pos).not.toBeNull();
    expect(textAt(doc, pos!, "second".length)).toBe("second");
  });

  it("maps a column inside a line following an unwrapped directive", async () => {
    const raw = "a\n\n::hr\n\nfind me here\n";
    const doc = await parseDoc(raw);

    const pos = rawLineToProsePosition(doc, 5, 6, raw);
    expect(pos).not.toBeNull();
    expect(textAt(doc, pos!, "me here".length)).toBe("me here");
  });
});
