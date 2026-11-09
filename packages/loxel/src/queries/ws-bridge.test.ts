import { afterEach, describe, expect, mock, test } from "bun:test";

const PATH = "/repo/src/a.ts";

let resolveFetch: (data: { content: string }) => void = () => {};
const actualClient = await import("@/api/client");
mock.module("@/api/client", () => ({
  ...actualClient,
  // Held open so a test can change the store while the request is in flight.
  getFileContentByPath: () =>
    new Promise<{ content: string }>((resolve) => {
      resolveFetch = resolve;
    }),
}));

const { checkOpenFileExists, refreshOpenFile } = await import("./ws-bridge");
const { useEditorStateStore } = await import("@/store/editor-state");

afterEach(() => {
  useEditorStateStore.setState({ files: new Map() });
});

describe("checkOpenFileExists", () => {
  test("restores a file marked deleted while its existence check was in flight", async () => {
    const store = useEditorStateStore.getState();
    store.openFile(PATH);

    const check = checkOpenFileExists("/repo", "/repo", PATH);
    // The editor's own refetch 404s first and marks the file deleted...
    useEditorStateStore.getState().setDeleted(PATH, true);
    // ...then this check finds it back (e.g. a checkout re-created it).
    resolveFetch({ content: "restored" });
    await check;

    const entry = useEditorStateStore.getState().files.get(PATH);
    expect(entry?.deleted).toBe(false);
    expect(entry?.baseContent).toBeNull();
    expect(entry?.state).toBe("clean");
  });

  test("leaves a file alone when a move started while the check was in flight", async () => {
    const store = useEditorStateStore.getState();
    store.openFile(PATH);
    store.setDeleted(PATH, true);

    const check = checkOpenFileExists("/repo", "/repo", PATH);
    useEditorStateStore.getState().setMovedTo(PATH, "/repo/src/b.ts");
    resolveFetch({ content: "restored" });
    await check;

    expect(useEditorStateStore.getState().files.get(PATH)?.deleted).toBe(true);
  });
});

describe("refreshOpenFile", () => {
  test("clears deleted on a clean editor when the file comes back unchanged", async () => {
    const store = useEditorStateStore.getState();
    store.openFile(PATH);
    // Marked deleted by a parent-directory check: the editor's own query never saw a 404.
    store.setDeleted(PATH, true);

    refreshOpenFile("/repo", "/repo", PATH, []);
    resolveFetch({ content: "same as before" });
    await Bun.sleep(0);

    expect(useEditorStateStore.getState().files.get(PATH)?.deleted).toBe(false);
  });
});

describe("refreshOpenFile with several editors of one file", () => {
  test("runs each editor's own state machine, matching nonces per editor", async () => {
    const store = useEditorStateStore.getState();
    store.openFile(PATH);
    store.openFile("compare-1:new", PATH);
    store.setBaseContent(PATH, "base");
    // The compare side saved; its echo is its own and an external change for the tab.
    store.markSaving("compare-1:new", "nonce-1");
    store.markDirty(PATH);

    refreshOpenFile("/repo", "/repo", "compare-1:new", ["nonce-1"]);
    resolveFetch({ content: "saved by compare" });
    await Bun.sleep(0);
    refreshOpenFile("/repo", "/repo", PATH, ["nonce-1"]);
    resolveFetch({ content: "saved by compare" });
    await Bun.sleep(0);

    const { files } = useEditorStateStore.getState();
    const compareSide = files.get("compare-1:new");
    expect(compareSide?.pendingNonces.size).toBe(0);
    expect(compareSide?.state).toBe("clean");
    // The tab has no editor callbacks registered here, so it cannot merge and diverges.
    expect(files.get(PATH)?.state).toBe("diverged");
    expect(files.get(PATH)?.diskContent).toBe("saved by compare");
  });
});
