import { describe, expect, it } from "bun:test";

import { Editor, defaultValueCtx, rootCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { getMarkdown } from "@milkdown/kit/utils";

import { localDbDirectivePlugins } from "./index.ts";

/** Parse → serialize through the real Milkdown pipeline (same plugins the editor installs). */
async function roundTrip(markdown: string): Promise<string> {
  const editor = Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, document.createElement("div"));
      ctx.set(defaultValueCtx, markdown);
    })
    .use(commonmark)
    .use(gfm)
    .use(localDbDirectivePlugins);
  await editor.create();
  const out = editor.action(getMarkdown());
  await editor.destroy();
  return out;
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
    // the output keeps exactly those two fences instead of adding one per round-trip.
    await expectFixedPoint(
      ":::a\n:::localdb\ntable: t\n:::\n:::\n",
      ":::a\n\n:::localdb\ntable: t\nview: table\n\n:::\n\n:::\n",
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
