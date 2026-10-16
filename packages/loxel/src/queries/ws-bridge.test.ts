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

const { checkOpenFileExists } = await import("./ws-bridge");
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
