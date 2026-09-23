import { describe, expect, test } from "bun:test";

import { Schema } from "@milkdown/kit/prose/model";
import { EditorState, TextSelection } from "@milkdown/kit/prose/state";

import { createMinimalReplaceTransaction } from "./prosemirror-replace";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "inline*", group: "block", toDOM: () => ["p", 0] },
    text: { group: "inline" },
  },
});

const p = (text?: string) =>
  schema.nodes.paragraph.create(null, text ? schema.text(text) : undefined);
const doc = (...children: ReturnType<typeof p>[]) => schema.nodes.doc.create(null, children);

function stateWithCaret(d: ReturnType<typeof doc>, pos: number): EditorState {
  return EditorState.create({ doc: d, selection: TextSelection.create(d, pos) });
}

describe("createMinimalReplaceTransaction", () => {
  test("returns null when documents are identical", () => {
    const state = stateWithCaret(doc(p("hello")), 3);
    expect(createMinimalReplaceTransaction(state, doc(p("hello")))).toBeNull();
  });

  test("keeps caret in place when an empty paragraph before it disappears", () => {
    // doc: <p></p><p>hello world</p> — caret after "hello" (pos 2 + 1 + 5 = 8)
    const before = doc(p(), p("hello world"));
    const state = stateWithCaret(before, 8);
    expect(state.doc.textBetween(3, state.selection.from)).toBe("hello");

    // Round-tripped doc drops the empty paragraph (each vanished paragraph shifts by 2).
    const after = doc(p("hello world"));
    const tr = createMinimalReplaceTransaction(state, after);
    expect(tr).not.toBeNull();
    const next = state.apply(tr!);

    expect(next.doc.eq(after)).toBe(true);
    expect(next.selection.from).toBe(6);
    expect(next.doc.textBetween(1, next.selection.from)).toBe("hello");
    expect(tr!.getMeta("addToHistory")).toBe(false);
  });

  test("keeps caret in place when content is appended after it", () => {
    const before = doc(p("hello"));
    const state = stateWithCaret(before, 3);
    const after = doc(p("hello"), p("appended by agent"));
    const next = state.apply(createMinimalReplaceTransaction(state, after)!);
    expect(next.doc.eq(after)).toBe(true);
    expect(next.selection.from).toBe(3);
  });

  test("keeps caret in the tail when content before it changes", () => {
    const before = doc(p("first"), p("second"));
    const state = stateWithCaret(before, 10); // inside "second" after "se"
    const after = doc(p("a much longer first"), p("second"));
    const next = state.apply(createMinimalReplaceTransaction(state, after)!);
    expect(next.doc.eq(after)).toBe(true);
    expect(next.doc.textBetween(next.selection.from - 2, next.selection.from)).toBe("se");
  });

  test("always produces exactly the target document", () => {
    const before = doc(p("one"), p(), p("two"), p("three"));
    const state = stateWithCaret(before, 2);
    const after = doc(p("one two"), p("three"), p("four"));
    const next = state.apply(createMinimalReplaceTransaction(state, after)!);
    expect(next.doc.eq(after)).toBe(true);
  });

  test("keeps caret when the live doc ends in a trailing empty paragraph", () => {
    // Milkdown's trailing plugin appends an empty paragraph that the parser never produces.
    const before = doc(p("first"), p("second"), p());
    const state = stateWithCaret(before, 7 + 1 + 2); // "se|cond"
    const after = doc(p("a much longer first"), p("second"));
    const next = state.apply(createMinimalReplaceTransaction(state, after)!);
    expect(next.doc.eq(doc(p("a much longer first"), p("second"), p()))).toBe(true);
    expect(next.doc.textBetween(next.selection.from - 2, next.selection.from)).toBe("se");
    expect(next.selection.$from.parent.textContent).toBe("second");
  });

  test("handles overlapping prefix/suffix (repeated character deletion)", () => {
    const before = doc(p("aaa"));
    const state = stateWithCaret(before, 3);
    const after = doc(p("aa"));
    const next = state.apply(createMinimalReplaceTransaction(state, after)!);
    expect(next.doc.eq(after)).toBe(true);
    expect(next.selection.from).toBe(3);
  });

  test("handles overlapping prefix/suffix (repeated character insertion)", () => {
    const before = doc(p("aa"));
    const state = stateWithCaret(before, 3);
    const after = doc(p("aaa"));
    const next = state.apply(createMinimalReplaceTransaction(state, after)!);
    expect(next.doc.eq(after)).toBe(true);
  });
});
