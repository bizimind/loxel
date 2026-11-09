import { afterEach, describe, expect, mock, test } from "bun:test";

const actualClient = await import("@/api/client");
mock.module("@/api/client", () => ({
  ...actualClient,
  writeFileContent: async (options: { content: string }) => ({
    success: true,
    content: `formatted ${options.content}`,
  }),
}));

const { consumeSavedContent, saveEditorContent } = await import("./save-editor-content");
const { useEditorStateStore } = await import("@/store/editor-state");

afterEach(() => {
  useEditorStateStore.setState({ files: new Map() });
});

describe("saved content stash", () => {
  test("is handed only to the editor that saved, not to other editors of the file", async () => {
    const store = useEditorStateStore.getState();
    store.openFile("/repo/a.ts");
    store.openFile("compare-1:old", "/repo/a.ts");

    await saveEditorContent("/repo/a.ts", "text", "/repo", undefined, "compare-1:old");
    const [nonce] = useEditorStateStore.getState().files.get("compare-1:old")!.pendingNonces;

    expect(consumeSavedContent(nonce!, "compare-1:old")).toBe("formatted text");
    expect(consumeSavedContent(nonce!, "/repo/a.ts")).toBeUndefined();
  });
});
