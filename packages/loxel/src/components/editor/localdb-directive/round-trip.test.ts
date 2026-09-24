import { describe, expect, it } from "bun:test";

import { Editor, defaultValueCtx, editorViewCtx, rootCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { getMarkdown } from "@milkdown/kit/utils";

import { localDbDirectivePlugins } from "./index.ts";

/** Parse → serialize through the real Milkdown pipeline (same plugins the editor installs). */
async function makeEditor(markdown: string): Promise<Editor> {
  const editor = Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, document.createElement("div"));
      ctx.set(defaultValueCtx, markdown);
    })
    .use(commonmark)
    .use(gfm)
    .use(localDbDirectivePlugins);
  await editor.create();
  return editor;
}

async function roundTrip(markdown: string): Promise<string> {
  const editor = await makeEditor(markdown);
  const out = editor.action(getMarkdown());
  await editor.destroy();
  return out;
}

function hasNode(editor: Editor, name: string): boolean {
  let found = false;
  editor.action((ctx) => {
    ctx.get(editorViewCtx).state.doc.descendants((node) => {
      if (node.type.name === name) found = true;
      return !found;
    });
  });
  return found;
}

async function expectFixedPoint(markdown: string, expected: string): Promise<void> {
  const once = await roundTrip(markdown);
  expect(once).toBe(expected);
  expect(await roundTrip(once)).toBe(once);
}

describe("localdb directive Milkdown round-trip", () => {
  it("re-emits a closed :::localdb block with unknown lines preserved", async () => {
    await expectFixedPoint(
      "before\n\n:::localdb\ntable: tasks\ncolor: red\n\n# heading\n:::\n\nafter\n",
      "before\n\n:::localdb\ntable: tasks\nview: table\ncolor: red\n\n# heading\n:::\n\nafter\n",
    );
  });

  it("does not manufacture a closing fence for a localdb block nested in another container", async () => {
    // The first `:::` closes the outer container, the second is a stray paragraph in the source;
    // the output keeps exactly those two lines (the stray one escaped as prose) instead of
    // adding a fence per round-trip.
    await expectFixedPoint(
      ":::a\n:::localdb\ntable: t\n:::\n:::\n",
      ":::a\n\n:::localdb\ntable: t\nview: table\n\n:::\n\n\\:::\n",
    );
  });

  it("does not manufacture a closing fence for an unclosed localdb block", async () => {
    await expectFixedPoint(
      "before\n\n:::localdb\ntable: tasks\n\nafter paragraph\n",
      "before\n\n:::localdb\ntable: tasks\nview: table\n\nafter paragraph\n",
    );
  });

  it("keeps the table binding of a localdb block under mixed container prefixes", async () => {
    for (const md of [
      "> - :::localdb\n>   table: t\n>   :::\n",
      "- > :::localdb\n  > table: t\n  > :::\n",
      "> 1. :::localdb\n>    table: t\n>    :::\n",
    ]) {
      const once = await roundTrip(md);
      expect(once).toContain("table: t\n");
      expect(once.match(/:::/g)).toHaveLength(2);
      expect(await roundTrip(once)).toBe(once);
    }
  });

  it("widens the fence so ::: lines preserved in the body cannot close the block early", async () => {
    await expectFixedPoint(
      "::::localdb\ntable: t\nnote\n:::\nend\n::::\n",
      "::::localdb\ntable: t\nview: table\nnote\n:::\nend\n::::\n",
    );
    await expectFixedPoint(
      "::::localdb\ntable: t\n\n:::note\nhi\n:::\n",
      "::::localdb\ntable: t\nview: table\n\n:::note\nhi\n:::\n",
    );
  });

  it("escapes a line-initial ::: typed as prose so it cannot become a directive on reload", async () => {
    const editor = await makeEditor("x\n");
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr.insertText(":::localdb", 1, 2));
    });
    const saved = editor.action(getMarkdown());
    await editor.destroy();
    expect(saved).toBe("\\:::localdb\n");

    const reloaded = await makeEditor(saved);
    expect(hasNode(reloaded, "localdb-block")).toBe(false);
    expect(reloaded.action(getMarkdown())).toBe(saved);
    await reloaded.destroy();
  });

  it("keeps escaped fences on disk as prose", async () => {
    await expectFixedPoint(
      "\\:::localdb\ntable: t\n\nafter\n",
      "\\:::localdb\ntable: t\n\nafter\n",
    );
  });

  it("keeps block html inside unwrapped directives, also in block quotes and list items", async () => {
    for (const md of [
      ":::note\n<div>hello</div>\n:::\n",
      "> :::note\n> <div>hello</div>\n> :::\n",
      "- :::note\n  <div>hello</div>\n  :::\n",
    ]) {
      const once = await roundTrip(md);
      expect(once).toContain("<div>hello</div>");
      expect(once).toContain(":::note");
      expect(once.match(/:::/g)).toHaveLength(2);
      expect(await roundTrip(once)).toBe(once);
    }
  });

  it("leaves prose with colons and other directives intact", async () => {
    await expectFixedPoint("Meeting at 10:30am, key:value\n", "Meeting at 10:30am, key:value\n");
    await expectFixedPoint("a\n\n::hr\n\nb\n", "a\n\n::hr\n\nb\n");
    await expectFixedPoint(":::note[Title]\nbody\n:::\n", ":::note[Title]\n\nbody\n\n:::\n");
    await expectFixedPoint(
      "> :::localdb\n> table: tasks\n> view: kanban\n> :::\n",
      "> :::localdb\n> table: tasks\n> view: kanban\n> :::\n",
    );
  });
});
