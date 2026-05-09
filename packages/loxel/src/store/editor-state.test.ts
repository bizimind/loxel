import { afterEach, describe, expect, test } from "bun:test";

import { useEditorStateStore } from "./editor-state";

const FILE = "test.md";

afterEach(() => {
  // Reset store between tests
  useEditorStateStore.setState({ files: new Map() });
});

function getEntry() {
  return useEditorStateStore.getState().files.get(FILE);
}

describe("editor state machine", () => {
  test("openFile creates a clean entry", () => {
    useEditorStateStore.getState().openFile(FILE);
    const entry = getEntry();
    expect(entry).toBeDefined();
    expect(entry!.state).toBe("clean");
    expect(entry!.pendingNonces.size).toBe(0);
  });

  test("markDirty transitions clean → dirty", () => {
    useEditorStateStore.getState().openFile(FILE);
    useEditorStateStore.getState().markDirty(FILE);
    expect(getEntry()!.state).toBe("dirty");
  });

  test("markDirty is a no-op when already dirty", () => {
    useEditorStateStore.getState().openFile(FILE);
    useEditorStateStore.getState().markDirty(FILE);
    const before = getEntry();
    useEditorStateStore.getState().markDirty(FILE);
    const after = getEntry();
    expect(before).toBe(after); // same reference — no state update
  });

  test("markSaving transitions to saving and adds nonce", () => {
    useEditorStateStore.getState().openFile(FILE);
    useEditorStateStore.getState().markDirty(FILE);
    useEditorStateStore.getState().markSaving(FILE, "nonce-A");
    const entry = getEntry()!;
    expect(entry.state).toBe("saving");
    expect(entry.pendingNonces.has("nonce-A")).toBe(true);
  });

  test("handleSaveError removes nonce and transitions to dirty", () => {
    useEditorStateStore.getState().openFile(FILE);
    useEditorStateStore.getState().markSaving(FILE, "nonce-A");
    useEditorStateStore.getState().handleSaveError(FILE, "nonce-A");
    const entry = getEntry()!;
    expect(entry.state).toBe("dirty");
    expect(entry.pendingNonces.has("nonce-A")).toBe(false);
  });
});

describe("conflict detection — handleDiskChange", () => {
  test("own echo in saving state → clean", () => {
    useEditorStateStore.getState().openFile(FILE);
    useEditorStateStore.getState().markSaving(FILE, "nonce-A");
    useEditorStateStore.getState().handleDiskChange(FILE, ["nonce-A"], "hello");
    const entry = getEntry()!;
    expect(entry.state).toBe("clean");
    expect(entry.pendingNonces.size).toBe(0);
  });

  test("external change in saving state → diverged", () => {
    useEditorStateStore.getState().openFile(FILE);
    useEditorStateStore.getState().markSaving(FILE, "nonce-A");
    useEditorStateStore.getState().handleDiskChange(FILE, [], "external content");
    const entry = getEntry()!;
    expect(entry.state).toBe("diverged");
    expect(entry.diskContent).toBe("external content");
  });

  test("own echo while dirty (typing during save) → stays dirty", () => {
    useEditorStateStore.getState().openFile(FILE);
    useEditorStateStore.getState().markSaving(FILE, "nonce-A");
    // User types → markDirty transitions saving → dirty (nonces preserved via spread)
    useEditorStateStore.getState().markDirty(FILE);
    expect(getEntry()!.state).toBe("dirty");
    expect(getEntry()!.pendingNonces.has("nonce-A")).toBe(true);
    // WS echo arrives with matching nonce
    useEditorStateStore.getState().handleDiskChange(FILE, ["nonce-A"], "hello");
    const entry = getEntry()!;
    expect(entry.state).toBe("dirty"); // stays dirty, NOT diverged
    expect(entry.pendingNonces.has("nonce-A")).toBe(false); // nonce consumed
  });

  test("overlapping saves — first echo arrives after second save starts", () => {
    // Scenario: save A starts, user types, save B starts, echo A arrives
    useEditorStateStore.getState().openFile(FILE);
    useEditorStateStore.getState().markSaving(FILE, "nonce-A");
    // User types → dirty
    useEditorStateStore.getState().markDirty(FILE);
    // Second save starts
    useEditorStateStore.getState().markSaving(FILE, "nonce-B");
    expect(getEntry()!.pendingNonces.has("nonce-A")).toBe(true);
    expect(getEntry()!.pendingNonces.has("nonce-B")).toBe(true);
    // First echo arrives — should NOT diverge, should stay saving (B still pending)
    useEditorStateStore.getState().handleDiskChange(FILE, ["nonce-A"], "content-A");
    const entry = getEntry()!;
    expect(entry.state).toBe("saving"); // still saving, waiting for B
    expect(entry.pendingNonces.has("nonce-A")).toBe(false);
    expect(entry.pendingNonces.has("nonce-B")).toBe(true);
    // Second echo arrives → clean
    useEditorStateStore.getState().handleDiskChange(FILE, ["nonce-B"], "content-B");
    expect(getEntry()!.state).toBe("clean");
    expect(getEntry()!.pendingNonces.size).toBe(0);
  });

  test("overlapping saves — batched echo with multiple nonces", () => {
    // Server debounce batches both saves into one flush, returning both nonces
    useEditorStateStore.getState().openFile(FILE);
    useEditorStateStore.getState().markSaving(FILE, "nonce-A");
    useEditorStateStore.getState().markDirty(FILE);
    useEditorStateStore.getState().markSaving(FILE, "nonce-B");
    // Single batched echo arrives with both nonces
    useEditorStateStore.getState().handleDiskChange(FILE, ["nonce-A", "nonce-B"], "content-B");
    expect(getEntry()!.state).toBe("clean");
    expect(getEntry()!.pendingNonces.size).toBe(0);
  });

  test("genuine external change while dirty → diverged", () => {
    useEditorStateStore.getState().openFile(FILE);
    useEditorStateStore.getState().markDirty(FILE);
    useEditorStateStore.getState().handleDiskChange(FILE, [], "external");
    const entry = getEntry()!;
    expect(entry.state).toBe("diverged");
    expect(entry.diskContent).toBe("external");
  });

  test("external change with different nonce while dirty → diverged", () => {
    useEditorStateStore.getState().openFile(FILE);
    useEditorStateStore.getState().markSaving(FILE, "nonce-A");
    useEditorStateStore.getState().markDirty(FILE);
    // External change arrives with a different nonce
    useEditorStateStore.getState().handleDiskChange(FILE, ["nonce-B"], "external");
    expect(getEntry()!.state).toBe("diverged");
  });

  test("diverged state updates diskContent on subsequent external changes", () => {
    useEditorStateStore.getState().openFile(FILE);
    useEditorStateStore.getState().markDirty(FILE);
    useEditorStateStore.getState().handleDiskChange(FILE, [], "v1");
    expect(getEntry()!.state).toBe("diverged");
    useEditorStateStore.getState().handleDiskChange(FILE, [], "v2");
    expect(getEntry()!.diskContent).toBe("v2");
  });
});

describe("conflict resolution", () => {
  test("acceptDiskVersion transitions diverged → clean", () => {
    useEditorStateStore.getState().openFile(FILE);
    useEditorStateStore.getState().markDirty(FILE);
    useEditorStateStore.getState().handleDiskChange(FILE, [], "disk content");
    useEditorStateStore.getState().acceptDiskVersion(FILE);
    const entry = getEntry()!;
    expect(entry.state).toBe("clean");
    expect(entry.diskContent).toBeNull();
    expect(entry.pendingNonces.size).toBe(0);
  });

  test("keepMyChanges transitions diverged → dirty", () => {
    useEditorStateStore.getState().openFile(FILE);
    useEditorStateStore.getState().markDirty(FILE);
    useEditorStateStore.getState().handleDiskChange(FILE, [], "disk content");
    useEditorStateStore.getState().keepMyChanges(FILE);
    const entry = getEntry()!;
    expect(entry.state).toBe("dirty");
    expect(entry.diskContent).toBeNull();
  });
});

describe("3-way auto-merge", () => {
  test("external change during dirty with non-overlapping edits → auto-merge", () => {
    const store = useEditorStateStore.getState();
    store.openFile(FILE);
    store.setBaseContent(FILE, "a\nb\nc");
    let appliedContent = "" as string;
    store.registerEditorCallbacks(
      FILE,
      () => "X\nb\nc", // user edited top
      (merged) => {
        appliedContent = merged;
        return merged;
      },
    );
    store.markDirty(FILE);
    store.handleDiskChange(FILE, [], "a\nb\nZ"); // agent edited bottom
    expect(getEntry()!.state).toBe("dirty"); // stays dirty (needs autosave)
    expect(getEntry()!.diskContent).toBeNull(); // cleared
    expect(appliedContent).toBe("X\nb\nZ"); // merged result applied
    expect(getEntry()!.baseContent).toBe("X\nb\nZ"); // base updated
  });

  test("external change during dirty with overlapping edits → diverged", () => {
    const store = useEditorStateStore.getState();
    store.openFile(FILE);
    store.setBaseContent(FILE, "a\nb\nc");
    store.registerEditorCallbacks(
      FILE,
      () => "a\nX\nc", // user edited middle
      () => null,
    );
    store.markDirty(FILE);
    store.handleDiskChange(FILE, [], "a\nY\nc"); // agent edited same line
    expect(getEntry()!.state).toBe("diverged");
    expect(getEntry()!.diskContent).toBe("a\nY\nc");
  });

  test("external change during dirty with no baseContent → diverged", () => {
    const store = useEditorStateStore.getState();
    store.openFile(FILE);
    // No setBaseContent — base is null
    store.registerEditorCallbacks(
      FILE,
      () => "content",
      () => null,
    );
    store.markDirty(FILE);
    store.handleDiskChange(FILE, [], "external");
    expect(getEntry()!.state).toBe("diverged");
  });

  test("external change during dirty with no callbacks → diverged", () => {
    const store = useEditorStateStore.getState();
    store.openFile(FILE);
    store.setBaseContent(FILE, "base");
    // No registerEditorCallbacks — Excalidraw scenario
    store.markDirty(FILE);
    store.handleDiskChange(FILE, [], "external");
    expect(getEntry()!.state).toBe("diverged");
  });

  test("external change during saving with non-overlapping edits → auto-merge", () => {
    const store = useEditorStateStore.getState();
    store.openFile(FILE);
    store.setBaseContent(FILE, "a\nb\nc");
    store.registerEditorCallbacks(
      FILE,
      () => "X\nb\nc",
      (merged) => merged,
    );
    store.markSaving(FILE, "nonce-A");
    store.handleDiskChange(FILE, [], "a\nb\nZ"); // external, not our echo
    expect(getEntry()!.state).toBe("saving"); // still saving (nonce pending)
    expect(getEntry()!.baseContent).toBe("X\nb\nZ");
  });

  test("acceptDiskVersion updates baseContent", () => {
    const store = useEditorStateStore.getState();
    store.openFile(FILE);
    store.setBaseContent(FILE, "old-base");
    store.markDirty(FILE);
    store.handleDiskChange(FILE, [], "new-disk");
    store.acceptDiskVersion(FILE);
    expect(getEntry()!.baseContent).toBe("new-disk");
  });

  test("keepMyChanges advances baseContent to diskContent", () => {
    const store = useEditorStateStore.getState();
    store.openFile(FILE);
    store.setBaseContent(FILE, "old-base");
    store.markDirty(FILE);
    store.handleDiskChange(FILE, [], "new-disk");
    store.keepMyChanges(FILE);
    expect(getEntry()!.baseContent).toBe("new-disk");
    expect(getEntry()!.diskContent).toBeNull();
  });

  test("applyMergedContent returning canonicalized form sets correct baseContent", () => {
    const store = useEditorStateStore.getState();
    store.openFile(FILE);
    store.setBaseContent(FILE, "a\nb\nc");
    store.registerEditorCallbacks(
      FILE,
      () => "X\nb\nc",
      (_merged) => "NORMALIZED\nb\nZ", // editor normalizes the content
    );
    store.markDirty(FILE);
    store.handleDiskChange(FILE, [], "a\nb\nZ");
    expect(getEntry()!.baseContent).toBe("NORMALIZED\nb\nZ"); // uses canonicalized, not diskContent
  });
});

describe("superseded echo — stale own-echo must not merge", () => {
  test("superseded echo does not apply merge (no editor writes)", () => {
    // Save A captures editor "A1". User types "A1+u1". Save B captures "A1+u1".
    // User types "A1+u1+u2". Echo A arrives with server-formatted "A1-fmt".
    // The echo is superseded (B pending), so we must NOT call applyMergedContent —
    // merging against stale disk content could wipe user edits.
    const store = useEditorStateStore.getState();
    store.openFile(FILE);
    store.setBaseContent(FILE, "A1");

    let editorContent = "A1";
    let applyCalls = 0;
    store.registerEditorCallbacks(
      FILE,
      () => editorContent,
      (merged) => {
        applyCalls++;
        editorContent = merged;
        return merged;
      },
    );

    // Save A starts, snapshot = "A1"
    store.markSaving(FILE, "nonce-A");
    // User types
    editorContent = "A1+u1";
    store.markDirty(FILE);
    // Save B starts, snapshot = "A1+u1"
    store.markSaving(FILE, "nonce-B");
    // User types more
    editorContent = "A1+u1+u2";
    store.markDirty(FILE);

    // Echo A arrives — stale (B already wrote). Would try to merge "A1-fmt" into editor.
    store.handleDiskChange(FILE, ["nonce-A"], "A1-fmt");

    expect(applyCalls).toBe(0); // no programmatic write
    expect(editorContent).toBe("A1+u1+u2"); // user's edits untouched
    expect(getEntry()!.pendingNonces.has("nonce-A")).toBe(false);
    expect(getEntry()!.pendingNonces.has("nonce-B")).toBe(true);
    expect(getEntry()!.savedSnapshots.has("nonce-A")).toBe(false);
    expect(getEntry()!.savedSnapshots.has("nonce-B")).toBe(true);
  });

  test("per-nonce merge base — non-superseded echo uses its own snapshot", () => {
    // Only one save in flight → not superseded. Base used must be A's snapshot,
    // not whatever the latest snapshot happens to be.
    const store = useEditorStateStore.getState();
    store.openFile(FILE);
    store.setBaseContent(FILE, "a\nb\nc");

    let editorContent = "a\nb\nc"; // pre-save content
    let appliedMerge = "" as string;
    store.registerEditorCallbacks(
      FILE,
      () => editorContent,
      (merged) => {
        appliedMerge = merged;
        editorContent = merged;
        return merged;
      },
    );

    // Save A with snapshot "a\nb\nc" (content at save-start, before user typed "U")
    store.markSaving(FILE, "nonce-A");
    // User types "U"
    editorContent = "a\nb\nc\nU";
    store.markDirty(FILE);

    // Server formats "a\nb\nc" into "A\nB\nC" (capitalization) and echoes back.
    store.handleDiskChange(FILE, ["nonce-A"], "A\nB\nC");

    // 3-way merge with base="a\nb\nc", ours="a\nb\nc\nU", theirs="A\nB\nC".
    // Formatter hunk (0..3 replace) and user-append hunk (insertion at 3..3) don't
    // overlap — both apply. User's "U" is preserved on top of the formatted content.
    expect(appliedMerge).toBe("A\nB\nC\nU");
    expect(editorContent).toBe("A\nB\nC\nU");
    expect(getEntry()!.savedSnapshots.has("nonce-A")).toBe(false);
  });
});

describe("clearPendingNonce", () => {
  test("clears specific nonce when present", () => {
    useEditorStateStore.getState().openFile(FILE);
    useEditorStateStore.getState().markSaving(FILE, "nonce-A");
    useEditorStateStore.getState().markDirty(FILE);
    expect(getEntry()!.pendingNonces.has("nonce-A")).toBe(true);
    useEditorStateStore.getState().clearPendingNonce(FILE, "nonce-A");
    expect(getEntry()!.pendingNonces.has("nonce-A")).toBe(false);
  });

  test("is a no-op when nonce is not in the set", () => {
    useEditorStateStore.getState().openFile(FILE);
    const before = getEntry();
    useEditorStateStore.getState().clearPendingNonce(FILE, "nonexistent");
    const after = getEntry();
    expect(before).toBe(after);
  });
});
