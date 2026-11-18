import { afterEach, describe, expect, test } from "bun:test";

import { localServerId } from "@/api/local-server";
import { toServerId } from "@/api/worktree-ref";

import {
  diskBase,
  fileEditorKey,
  openEditorPaths,
  useEditorStateStore,
  viewEditorKey,
} from "./editor-state";

const TEST_SERVER = localServerId();
const FILE = "test.md";
const KEY = fileEditorKey(TEST_SERVER, FILE);

afterEach(() => {
  // Reset store between tests
  useEditorStateStore.setState({ files: new Map() });
});

function getEntry() {
  return useEditorStateStore.getState().files.get(KEY);
}

describe("editor state machine", () => {
  test("openFile creates a clean entry", () => {
    useEditorStateStore.getState().openFile(KEY, TEST_SERVER, FILE);
    const entry = getEntry();
    expect(entry).toBeDefined();
    expect(entry!.state).toBe("clean");
    expect(entry!.pendingNonces.size).toBe(0);
  });

  test("several editors of one file get independent entries", () => {
    const store = useEditorStateStore.getState();
    store.openFile(KEY, TEST_SERVER, FILE);
    const side = viewEditorKey("compare-1:old");
    store.openFile(side, TEST_SERVER, FILE);
    store.markDirty(side);

    const { files } = useEditorStateStore.getState();
    expect(files.get(side)?.filePath).toBe(FILE);
    expect(files.get(side)?.state).toBe("dirty");
    expect(getEntry()?.filePath).toBe(FILE);
    expect(getEntry()?.state).toBe("clean");
    expect(openEditorPaths(files, TEST_SERVER)).toEqual([FILE]);
  });

  test("the same path on two servers gets two file tabs", () => {
    const other = toServerId("other-server");
    const otherKey = fileEditorKey(other, FILE);
    const store = useEditorStateStore.getState();
    store.openFile(KEY, TEST_SERVER, FILE);
    store.openFile(otherKey, other, FILE);
    store.markDirty(otherKey);

    const { files } = useEditorStateStore.getState();
    expect(otherKey).not.toBe(KEY);
    expect(getEntry()?.state).toBe("clean");
    expect(files.get(otherKey)?.server).toBe(other);
    expect(files.get(otherKey)?.state).toBe("dirty");
    expect(openEditorPaths(files, TEST_SERVER)).toEqual([FILE]);
    expect(openEditorPaths(files, other)).toEqual([FILE]);
  });

  test("markDirty transitions clean → dirty", () => {
    useEditorStateStore.getState().openFile(KEY, TEST_SERVER, FILE);
    useEditorStateStore.getState().markDirty(KEY);
    expect(getEntry()!.state).toBe("dirty");
  });

  test("markDirty is a no-op when already dirty", () => {
    useEditorStateStore.getState().openFile(KEY, TEST_SERVER, FILE);
    useEditorStateStore.getState().markDirty(KEY);
    const before = getEntry();
    useEditorStateStore.getState().markDirty(KEY);
    const after = getEntry();
    expect(before).toBe(after); // same reference — no state update
  });

  test("markSaving transitions to saving and adds nonce", () => {
    useEditorStateStore.getState().openFile(KEY, TEST_SERVER, FILE);
    useEditorStateStore.getState().markDirty(KEY);
    useEditorStateStore.getState().markSaving(KEY, "nonce-A");
    const entry = getEntry()!;
    expect(entry.state).toBe("saving");
    expect(entry.pendingNonces.has("nonce-A")).toBe(true);
  });

  test("handleSaveError removes nonce and transitions to dirty", () => {
    useEditorStateStore.getState().openFile(KEY, TEST_SERVER, FILE);
    useEditorStateStore.getState().markSaving(KEY, "nonce-A");
    useEditorStateStore.getState().handleSaveError(KEY, "nonce-A");
    const entry = getEntry()!;
    expect(entry.state).toBe("dirty");
    expect(entry.pendingNonces.has("nonce-A")).toBe(false);
  });
});

describe("conflict detection — handleDiskChange", () => {
  test("own echo in saving state → clean", () => {
    useEditorStateStore.getState().openFile(KEY, TEST_SERVER, FILE);
    useEditorStateStore.getState().markSaving(KEY, "nonce-A");
    useEditorStateStore.getState().handleDiskChange(KEY, ["nonce-A"], "hello");
    const entry = getEntry()!;
    expect(entry.state).toBe("clean");
    expect(entry.pendingNonces.size).toBe(0);
  });

  test("external change in saving state → diverged", () => {
    useEditorStateStore.getState().openFile(KEY, TEST_SERVER, FILE);
    useEditorStateStore.getState().markSaving(KEY, "nonce-A");
    useEditorStateStore.getState().handleDiskChange(KEY, [], "external content");
    const entry = getEntry()!;
    expect(entry.state).toBe("diverged");
    expect(entry.diskContent).toBe("external content");
  });

  test("own echo while dirty (typing during save) → stays dirty", () => {
    useEditorStateStore.getState().openFile(KEY, TEST_SERVER, FILE);
    useEditorStateStore.getState().markSaving(KEY, "nonce-A");
    // User types → markDirty transitions saving → dirty (nonces preserved via spread)
    useEditorStateStore.getState().markDirty(KEY);
    expect(getEntry()!.state).toBe("dirty");
    expect(getEntry()!.pendingNonces.has("nonce-A")).toBe(true);
    // WS echo arrives with matching nonce
    useEditorStateStore.getState().handleDiskChange(KEY, ["nonce-A"], "hello");
    const entry = getEntry()!;
    expect(entry.state).toBe("dirty"); // stays dirty, NOT diverged
    expect(entry.pendingNonces.has("nonce-A")).toBe(false); // nonce consumed
  });

  test("overlapping saves — first echo arrives after second save starts", () => {
    // Scenario: save A starts, user types, save B starts, echo A arrives
    useEditorStateStore.getState().openFile(KEY, TEST_SERVER, FILE);
    useEditorStateStore.getState().markSaving(KEY, "nonce-A");
    // User types → dirty
    useEditorStateStore.getState().markDirty(KEY);
    // Second save starts
    useEditorStateStore.getState().markSaving(KEY, "nonce-B");
    expect(getEntry()!.pendingNonces.has("nonce-A")).toBe(true);
    expect(getEntry()!.pendingNonces.has("nonce-B")).toBe(true);
    // First echo arrives — should NOT diverge, should stay saving (B still pending)
    useEditorStateStore.getState().handleDiskChange(KEY, ["nonce-A"], "content-A");
    const entry = getEntry()!;
    expect(entry.state).toBe("saving"); // still saving, waiting for B
    expect(entry.pendingNonces.has("nonce-A")).toBe(false);
    expect(entry.pendingNonces.has("nonce-B")).toBe(true);
    // Second echo arrives → clean
    useEditorStateStore.getState().handleDiskChange(KEY, ["nonce-B"], "content-B");
    expect(getEntry()!.state).toBe("clean");
    expect(getEntry()!.pendingNonces.size).toBe(0);
  });

  test("overlapping saves — batched echo with multiple nonces", () => {
    // Server debounce batches both saves into one flush, returning both nonces
    useEditorStateStore.getState().openFile(KEY, TEST_SERVER, FILE);
    useEditorStateStore.getState().markSaving(KEY, "nonce-A");
    useEditorStateStore.getState().markDirty(KEY);
    useEditorStateStore.getState().markSaving(KEY, "nonce-B");
    // Single batched echo arrives with both nonces
    useEditorStateStore.getState().handleDiskChange(KEY, ["nonce-A", "nonce-B"], "content-B");
    expect(getEntry()!.state).toBe("clean");
    expect(getEntry()!.pendingNonces.size).toBe(0);
  });

  test("genuine external change while dirty → diverged", () => {
    useEditorStateStore.getState().openFile(KEY, TEST_SERVER, FILE);
    useEditorStateStore.getState().markDirty(KEY);
    useEditorStateStore.getState().handleDiskChange(KEY, [], "external");
    const entry = getEntry()!;
    expect(entry.state).toBe("diverged");
    expect(entry.diskContent).toBe("external");
  });

  test("external change with different nonce while dirty → diverged", () => {
    useEditorStateStore.getState().openFile(KEY, TEST_SERVER, FILE);
    useEditorStateStore.getState().markSaving(KEY, "nonce-A");
    useEditorStateStore.getState().markDirty(KEY);
    // External change arrives with a different nonce
    useEditorStateStore.getState().handleDiskChange(KEY, ["nonce-B"], "external");
    expect(getEntry()!.state).toBe("diverged");
  });

  test("diverged state updates diskContent on subsequent external changes", () => {
    useEditorStateStore.getState().openFile(KEY, TEST_SERVER, FILE);
    useEditorStateStore.getState().markDirty(KEY);
    useEditorStateStore.getState().handleDiskChange(KEY, [], "v1");
    expect(getEntry()!.state).toBe("diverged");
    useEditorStateStore.getState().handleDiskChange(KEY, [], "v2");
    expect(getEntry()!.diskContent).toBe("v2");
  });
});

describe("conflict resolution", () => {
  test("acceptDiskVersion transitions diverged → clean", () => {
    useEditorStateStore.getState().openFile(KEY, TEST_SERVER, FILE);
    useEditorStateStore.getState().markDirty(KEY);
    useEditorStateStore.getState().handleDiskChange(KEY, [], "disk content");
    useEditorStateStore.getState().acceptDiskVersion(KEY);
    const entry = getEntry()!;
    expect(entry.state).toBe("clean");
    expect(entry.diskContent).toBeNull();
    expect(entry.pendingNonces.size).toBe(0);
  });

  test("keepMyChanges transitions diverged → dirty", () => {
    useEditorStateStore.getState().openFile(KEY, TEST_SERVER, FILE);
    useEditorStateStore.getState().markDirty(KEY);
    useEditorStateStore.getState().handleDiskChange(KEY, [], "disk content");
    useEditorStateStore.getState().keepMyChanges(KEY);
    const entry = getEntry()!;
    expect(entry.state).toBe("dirty");
    expect(entry.diskContent).toBeNull();
  });
});

describe("3-way auto-merge", () => {
  test("external change during dirty with non-overlapping edits → auto-merge", () => {
    const store = useEditorStateStore.getState();
    store.openFile(KEY, TEST_SERVER, FILE);
    store.setBaseContent(KEY, "a\nb\nc");
    let appliedContent = "" as string;
    store.registerEditorCallbacks(
      KEY,
      () => "X\nb\nc", // user edited top
      (merged) => {
        appliedContent = merged;
        return merged;
      },
    );
    store.markDirty(KEY);
    store.handleDiskChange(KEY, [], "a\nb\nZ"); // agent edited bottom
    expect(getEntry()!.state).toBe("dirty"); // stays dirty (needs autosave)
    expect(getEntry()!.diskContent).toBeNull(); // cleared
    expect(appliedContent).toBe("X\nb\nZ"); // merged result applied
    expect(getEntry()!.baseContent).toBe("X\nb\nZ"); // base updated
  });

  test("external change during dirty with overlapping edits → diverged", () => {
    const store = useEditorStateStore.getState();
    store.openFile(KEY, TEST_SERVER, FILE);
    store.setBaseContent(KEY, "a\nb\nc");
    store.registerEditorCallbacks(
      KEY,
      () => "a\nX\nc", // user edited middle
      () => null,
    );
    store.markDirty(KEY);
    store.handleDiskChange(KEY, [], "a\nY\nc"); // agent edited same line
    expect(getEntry()!.state).toBe("diverged");
    expect(getEntry()!.diskContent).toBe("a\nY\nc");
  });

  test("external change during dirty with no baseContent → diverged", () => {
    const store = useEditorStateStore.getState();
    store.openFile(KEY, TEST_SERVER, FILE);
    // No setBaseContent — base is null
    store.registerEditorCallbacks(
      KEY,
      () => "content",
      () => null,
    );
    store.markDirty(KEY);
    store.handleDiskChange(KEY, [], "external");
    expect(getEntry()!.state).toBe("diverged");
  });

  test("external change during dirty with no callbacks → diverged", () => {
    const store = useEditorStateStore.getState();
    store.openFile(KEY, TEST_SERVER, FILE);
    store.setBaseContent(KEY, "base");
    // No registerEditorCallbacks — Excalidraw scenario
    store.markDirty(KEY);
    store.handleDiskChange(KEY, [], "external");
    expect(getEntry()!.state).toBe("diverged");
  });

  test("external change during saving with non-overlapping edits → auto-merge", () => {
    const store = useEditorStateStore.getState();
    store.openFile(KEY, TEST_SERVER, FILE);
    store.setBaseContent(KEY, "a\nb\nc");
    store.registerEditorCallbacks(
      KEY,
      () => "X\nb\nc",
      (merged) => merged,
    );
    store.markSaving(KEY, "nonce-A");
    store.handleDiskChange(KEY, [], "a\nb\nZ"); // external, not our echo
    expect(getEntry()!.state).toBe("saving"); // still saving (nonce pending)
    expect(getEntry()!.baseContent).toBe("X\nb\nZ");
  });

  test("acceptDiskVersion updates baseContent", () => {
    const store = useEditorStateStore.getState();
    store.openFile(KEY, TEST_SERVER, FILE);
    store.setBaseContent(KEY, "old-base");
    store.markDirty(KEY);
    store.handleDiskChange(KEY, [], "new-disk");
    store.acceptDiskVersion(KEY);
    expect(getEntry()!.baseContent).toBe("new-disk");
  });

  test("keepMyChanges advances baseContent to diskContent", () => {
    const store = useEditorStateStore.getState();
    store.openFile(KEY, TEST_SERVER, FILE);
    store.setBaseContent(KEY, "old-base");
    store.markDirty(KEY);
    store.handleDiskChange(KEY, [], "new-disk");
    store.keepMyChanges(KEY);
    expect(getEntry()!.baseContent).toBe("new-disk");
    expect(getEntry()!.diskContent).toBeNull();
  });

  test("applyMergedContent returning canonicalized form sets correct baseContent", () => {
    const store = useEditorStateStore.getState();
    store.openFile(KEY, TEST_SERVER, FILE);
    store.setBaseContent(KEY, "a\nb\nc");
    store.registerEditorCallbacks(
      KEY,
      () => "X\nb\nc",
      (_merged) => "NORMALIZED\nb\nZ", // editor normalizes the content
    );
    store.markDirty(KEY);
    store.handleDiskChange(KEY, [], "a\nb\nZ");
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
    store.openFile(KEY, TEST_SERVER, FILE);
    store.setBaseContent(KEY, "A1");

    let editorContent = "A1";
    let applyCalls = 0;
    store.registerEditorCallbacks(
      KEY,
      () => editorContent,
      (merged) => {
        applyCalls++;
        editorContent = merged;
        return merged;
      },
    );

    // Save A starts, snapshot = "A1"
    store.markSaving(KEY, "nonce-A");
    // User types
    editorContent = "A1+u1";
    store.markDirty(KEY);
    // Save B starts, snapshot = "A1+u1"
    store.markSaving(KEY, "nonce-B");
    // User types more
    editorContent = "A1+u1+u2";
    store.markDirty(KEY);

    // Echo A arrives — stale (B already wrote). Would try to merge "A1-fmt" into editor.
    store.handleDiskChange(KEY, ["nonce-A"], "A1-fmt");

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
    store.openFile(KEY, TEST_SERVER, FILE);
    store.setBaseContent(KEY, "a\nb\nc");

    let editorContent = "a\nb\nc"; // pre-save content
    let appliedMerge = "" as string;
    store.registerEditorCallbacks(
      KEY,
      () => editorContent,
      (merged) => {
        appliedMerge = merged;
        editorContent = merged;
        return merged;
      },
    );

    // Save A with snapshot "a\nb\nc" (content at save-start, before user typed "U")
    store.markSaving(KEY, "nonce-A");
    // User types "U"
    editorContent = "a\nb\nc\nU";
    store.markDirty(KEY);

    // Server formats "a\nb\nc" into "A\nB\nC" (capitalization) and echoes back.
    store.handleDiskChange(KEY, ["nonce-A"], "A\nB\nC");

    // 3-way merge with base="a\nb\nc", ours="a\nb\nc\nU", theirs="A\nB\nC".
    // Formatter hunk (0..3 replace) and user-append hunk (insertion at 3..3) don't
    // overlap — both apply. User's "U" is preserved on top of the formatted content.
    expect(appliedMerge).toBe("A\nB\nC\nU");
    expect(editorContent).toBe("A\nB\nC\nU");
    expect(getEntry()!.savedSnapshots.has("nonce-A")).toBe(false);
  });
});

describe("own echo while typing — merge resolves to editor content", () => {
  test("saving state: does not apply, clears nonce, goes dirty with disk as base", () => {
    const store = useEditorStateStore.getState();
    store.openFile(KEY, TEST_SERVER, FILE);
    store.setBaseContent(KEY, "a\nb\nc");
    let editorContent = "a\nb\nc";
    let applyCalls = 0;
    store.registerEditorCallbacks(
      KEY,
      () => editorContent,
      (merged) => {
        applyCalls++;
        editorContent = merged;
        return merged;
      },
    );
    store.markSaving(KEY, "nonce-A"); // snapshot "a\nb\nc"
    // User keeps typing while the save is in flight; the debounced change listener
    // has not fired yet, so state is still "saving".
    editorContent = "a\nb\nc\ntyped";

    store.handleDiskChange(KEY, ["nonce-A"], "a\nb\nc");

    const entry = getEntry()!;
    expect(applyCalls).toBe(0); // editor doc untouched — caret stays put
    expect(editorContent).toBe("a\nb\nc\ntyped");
    expect(entry.pendingNonces.has("nonce-A")).toBe(false);
    expect(entry.savedSnapshots.has("nonce-A")).toBe(false);
    expect(entry.state).toBe("dirty"); // newer chars still need saving
    expect(entry.baseContent).toBe("a\nb\nc"); // disk is the common ancestor
    expect(entry.diskContent).toBeNull();
  });

  test("dirty state: does not apply and keeps dirty", () => {
    const store = useEditorStateStore.getState();
    store.openFile(KEY, TEST_SERVER, FILE);
    store.setBaseContent(KEY, "a");
    let editorContent = "a";
    let applyCalls = 0;
    store.registerEditorCallbacks(
      KEY,
      () => editorContent,
      (merged) => {
        applyCalls++;
        return merged;
      },
    );
    store.markSaving(KEY, "nonce-A");
    editorContent = "a\nmore";
    store.markDirty(KEY);
    store.handleDiskChange(KEY, ["nonce-A"], "a");
    expect(applyCalls).toBe(0);
    expect(getEntry()!.state).toBe("dirty");
    expect(getEntry()!.pendingNonces.size).toBe(0);
    expect(getEntry()!.baseContent).toBe("a");
  });

  test("later external change merges against the disk base without losing typed text", () => {
    const store = useEditorStateStore.getState();
    store.openFile(KEY, TEST_SERVER, FILE);
    store.setBaseContent(KEY, "a\nb\nc");
    let editorContent = "a\nb\nc";
    let applied = "" as string;
    store.registerEditorCallbacks(
      KEY,
      () => editorContent,
      (merged) => {
        applied = merged;
        editorContent = merged;
        return merged;
      },
    );
    store.markSaving(KEY, "nonce-A");
    editorContent = "a\nb\nc\ntyped";
    store.handleDiskChange(KEY, ["nonce-A"], "a\nb\nc");
    expect(applied).toBe("");

    // Agent edits the top of the file on disk before the next autosave lands.
    store.handleDiskChange(KEY, [], "X\nb\nc");
    expect(applied).toBe("X\nb\nc\ntyped");
    expect(getEntry()!.state).toBe("dirty");
  });

  test("format echo that differs from the live doc is applied non-programmatically", () => {
    const store = useEditorStateStore.getState();
    store.openFile(KEY, TEST_SERVER, FILE);
    store.setBaseContent(KEY, "a\nb\nc");
    let editorContent = "a\nb\nc";
    const programmaticFlags: boolean[] = [];
    store.registerEditorCallbacks(
      KEY,
      () => editorContent,
      (merged, programmatic) => {
        programmaticFlags.push(programmatic);
        editorContent = merged;
        return merged;
      },
    );
    store.markSaving(KEY, "nonce-A");
    editorContent = "a\nb\nc\nU";
    store.handleDiskChange(KEY, ["nonce-A"], "A\nB\nC");
    expect(editorContent).toBe("A\nB\nC\nU");
    // Merged content is not what is on disk → editor must re-arm autosave.
    expect(programmaticFlags).toEqual([false]);
    expect(getEntry()!.state).toBe("dirty");
  });

  test("format echo matching the live doc after merge is applied programmatically", () => {
    const store = useEditorStateStore.getState();
    store.openFile(KEY, TEST_SERVER, FILE);
    store.setBaseContent(KEY, "a\nb\nc");
    let editorContent = "a\nb\nc";
    const programmaticFlags: boolean[] = [];
    store.registerEditorCallbacks(
      KEY,
      () => editorContent,
      (merged, programmatic) => {
        programmaticFlags.push(programmatic);
        editorContent = merged;
        return merged;
      },
    );
    store.markSaving(KEY, "nonce-A");
    store.handleDiskChange(KEY, ["nonce-A"], "A\nB\nC");
    expect(editorContent).toBe("A\nB\nC");
    expect(programmaticFlags).toEqual([true]);
    expect(getEntry()!.state).toBe("clean");
  });
});

describe("clearPendingNonce", () => {
  test("clears specific nonce when present", () => {
    useEditorStateStore.getState().openFile(KEY, TEST_SERVER, FILE);
    useEditorStateStore.getState().markSaving(KEY, "nonce-A");
    useEditorStateStore.getState().markDirty(KEY);
    expect(getEntry()!.pendingNonces.has("nonce-A")).toBe(true);
    useEditorStateStore.getState().clearPendingNonce(KEY, "nonce-A");
    expect(getEntry()!.pendingNonces.has("nonce-A")).toBe(false);
  });

  test("is a no-op when nonce is not in the set", () => {
    useEditorStateStore.getState().openFile(KEY, TEST_SERVER, FILE);
    const before = getEntry();
    useEditorStateStore.getState().clearPendingNonce(KEY, "nonexistent");
    const after = getEntry();
    expect(before).toBe(after);
  });
});

describe("auto-merge apply failure", () => {
  test("applyMergedContent returning null falls through to diverged", () => {
    const store = useEditorStateStore.getState();
    store.openFile(KEY, TEST_SERVER, FILE);
    store.setBaseContent(KEY, "a\nb\nc");
    store.registerEditorCallbacks(
      KEY,
      () => "X\nb\nc",
      () => null, // editor could not apply the merge (e.g. body failed to parse)
    );
    store.markDirty(KEY);
    store.handleDiskChange(KEY, [], "a\nb\nZ");
    expect(getEntry()!.state).toBe("diverged");
    expect(getEntry()!.diskContent).toBe("a\nb\nZ");
    expect(getEntry()!.baseContent).toBe("a\nb\nc");
  });
});

describe("deleted files — echoes", () => {
  test("a superseded echo still clears deleted", () => {
    const store = useEditorStateStore.getState();
    store.openFile(KEY, TEST_SERVER, FILE);
    store.markDirty(KEY);
    store.markSaving(KEY, "n1");
    store.markSaving(KEY, "n2");
    store.setDeleted(KEY, true);

    store.handleDiskChange(KEY, ["n1"], "first");

    expect(getEntry()?.deleted).toBe(false);
    expect(getEntry()?.pendingNonces.has("n1")).toBe(false);
    expect(getEntry()?.pendingNonces.has("n2")).toBe(true);
    expect(getEntry()?.state).toBe("saving");
  });

  test("setDeleted and handleDiskChange ignore unknown paths", () => {
    const store = useEditorStateStore.getState();
    const missing = fileEditorKey(TEST_SERVER, "missing.md");
    store.setDeleted(missing, true);
    store.handleDiskChange(missing, [], "x");
    expect(store.files.size).toBe(0);
  });
});

describe("moved files", () => {
  test("setMovedTo records the new path on existing entries only", () => {
    const store = useEditorStateStore.getState();
    store.openFile(KEY, TEST_SERVER, FILE);
    store.setMovedTo(KEY, "new.md");
    expect(getEntry()?.movedTo).toBe("new.md");

    const unknown = fileEditorKey(TEST_SERVER, "unknown.md");
    store.setMovedTo(unknown, "x.md");
    expect(useEditorStateStore.getState().files.has(unknown)).toBe(false);
  });

  test("registerPendingEdit sets and clears the editor's pending-edit taker", () => {
    const store = useEditorStateStore.getState();
    store.openFile(KEY, TEST_SERVER, FILE);
    const take = () => null;
    store.registerPendingEdit(KEY, take);
    expect(getEntry()?.takePendingEdit).toBe(take);
    store.registerPendingEdit(KEY, null);
    expect(getEntry()?.takePendingEdit).toBeNull();
  });
});

describe("saves confirmed by the server", () => {
  test("markWritten makes the newest save's content the merge base", () => {
    const store = useEditorStateStore.getState();
    store.openFile(KEY, TEST_SERVER, FILE);
    store.setBaseContent(KEY, "a");
    store.markSaving(KEY, "n1");
    store.markSaving(KEY, "n2");

    store.markWritten(KEY, "n1", "older"); // a late response of an older save
    expect(getEntry()!.baseContent).toBe("a");
    store.markWritten(KEY, "n2", "newer");
    expect(getEntry()!.baseContent).toBe("newer");
  });
});

describe("disk content merged once", () => {
  test("the same disk content arriving again is not merged a second time", () => {
    const store = useEditorStateStore.getState();
    let editor = "X\nb\nc";
    store.openFile(KEY, TEST_SERVER, FILE);
    store.setBaseContent(KEY, "a\nb\nc");
    store.registerEditorCallbacks(
      KEY,
      () => editor,
      (merged) => {
        editor = merged;
        return merged;
      },
    );
    store.markDirty(KEY);
    store.handleDiskChange(KEY, [], "a\nb\nZ");
    expect(editor).toBe("X\nb\nZ");
    expect(diskBase(getEntry()!)).toBe("a\nb\nZ");

    // A resync after a reconnect reports the same disk content: the base is now the merge
    // result, so merging again would read as disk reverting the editor's edit.
    store.handleDiskChange(KEY, [], "a\nb\nZ");
    expect(editor).toBe("X\nb\nZ");
    expect(getEntry()!.state).toBe("dirty");
  });
});

describe("adoptQueuedEdit", () => {
  test("takes over a waiting save as unsaved edits, or as a conflict with the disk", () => {
    const store = useEditorStateStore.getState();
    store.openFile(KEY, TEST_SERVER, FILE);
    store.adoptQueuedEdit(KEY, { base: "base", disk: null });
    expect(getEntry()!.state).toBe("dirty");
    expect(getEntry()!.baseContent).toBe("base");

    store.adoptQueuedEdit(KEY, { base: "base", disk: "theirs" });
    expect(getEntry()!.state).toBe("diverged");
    expect(getEntry()!.diskContent).toBe("theirs");
  });
});
