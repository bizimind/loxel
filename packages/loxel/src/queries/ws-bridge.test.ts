import { afterEach, describe, expect, mock, test } from "bun:test";

import { localRef, localServerId } from "@/api/local-server";

const TEST_SERVER = localServerId();
const PATH = "/repo/src/a.ts";
const REPO = localRef("/repo");

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
const { fileEditorKey, useEditorStateStore, viewEditorKey } = await import("@/store/editor-state");
const KEY = fileEditorKey(TEST_SERVER, PATH);
const SIDE = viewEditorKey("compare-1:new");

afterEach(() => {
  useEditorStateStore.setState({ files: new Map() });
});

describe("checkOpenFileExists", () => {
  test("restores a file marked deleted while its existence check was in flight", async () => {
    const store = useEditorStateStore.getState();
    store.openFile(KEY, TEST_SERVER, PATH);

    const check = checkOpenFileExists(REPO, REPO, KEY);
    // The editor's own refetch 404s first and marks the file deleted...
    useEditorStateStore.getState().setDeleted(KEY, true);
    // ...then this check finds it back (e.g. a checkout re-created it).
    resolveFetch({ content: "restored" });
    await check;

    const entry = useEditorStateStore.getState().files.get(KEY);
    expect(entry?.deleted).toBe(false);
    expect(entry?.baseContent).toBeNull();
    expect(entry?.state).toBe("clean");
  });

  test("leaves a file alone when a move started while the check was in flight", async () => {
    const store = useEditorStateStore.getState();
    store.openFile(KEY, TEST_SERVER, PATH);
    store.setDeleted(KEY, true);

    const check = checkOpenFileExists(REPO, REPO, KEY);
    useEditorStateStore.getState().setMovedTo(KEY, "/repo/src/b.ts");
    resolveFetch({ content: "restored" });
    await check;

    expect(useEditorStateStore.getState().files.get(KEY)?.deleted).toBe(true);
  });
});

describe("refreshOpenFile", () => {
  test("clears deleted on a clean editor when the file comes back unchanged", async () => {
    const store = useEditorStateStore.getState();
    store.openFile(KEY, TEST_SERVER, PATH);
    // Marked deleted by a parent-directory check: the editor's own query never saw a 404.
    store.setDeleted(KEY, true);

    refreshOpenFile(REPO, REPO, KEY, []);
    resolveFetch({ content: "same as before" });
    await Bun.sleep(0);

    expect(useEditorStateStore.getState().files.get(KEY)?.deleted).toBe(false);
  });
});

describe("refreshOpenFile with several editors of one file", () => {
  test("runs each editor's own state machine, matching nonces per editor", async () => {
    const store = useEditorStateStore.getState();
    store.openFile(KEY, TEST_SERVER, PATH);
    store.openFile(SIDE, TEST_SERVER, PATH);
    store.setBaseContent(KEY, "base");
    // The compare side saved; its echo is its own and an external change for the tab.
    store.markSaving(SIDE, "nonce-1");
    store.markDirty(KEY);

    refreshOpenFile(REPO, REPO, SIDE, ["nonce-1"]);
    resolveFetch({ content: "saved by compare" });
    await Bun.sleep(0);
    refreshOpenFile(REPO, REPO, KEY, ["nonce-1"]);
    resolveFetch({ content: "saved by compare" });
    await Bun.sleep(0);

    const { files } = useEditorStateStore.getState();
    const compareSide = files.get(SIDE);
    expect(compareSide?.pendingNonces.size).toBe(0);
    expect(compareSide?.state).toBe("clean");
    // The tab has no editor callbacks registered here, so it cannot merge and diverges.
    expect(files.get(KEY)?.state).toBe("diverged");
    expect(files.get(KEY)?.diskContent).toBe("saved by compare");
  });
});
