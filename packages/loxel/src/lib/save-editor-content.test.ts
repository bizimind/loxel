import { afterEach, describe, expect, mock, test } from "bun:test";

import { localRef, localServerId } from "@/api/local-server";
import { toServerId, worktreeRef } from "@/api/worktree-ref";

const actualClient = await import("@/api/client");
mock.module("@/api/client", () => ({
  ...actualClient,
  writeFileContent: async (options: { content: string }) => ({
    success: true,
    content: `formatted ${options.content}`,
  }),
}));

const {
  consumeSavedContent,
  holdWorktree,
  onWorktreeSavesDrained,
  releaseWorktree,
  saveEditorContent,
} = await import("./save-editor-content");
const { fileEditorKey, useEditorStateStore, viewEditorKey } = await import("@/store/editor-state");

afterEach(() => {
  useEditorStateStore.setState({ files: new Map() });
});

describe("saved content stash", () => {
  test("is handed only to the editor that saved, not to other editors of the file", async () => {
    const store = useEditorStateStore.getState();
    const server = localServerId();
    const tab = fileEditorKey(server, "/repo/a.ts");
    const side = viewEditorKey("compare-1:old");
    store.openFile(tab, server, "/repo/a.ts");
    store.openFile(side, server, "/repo/a.ts");

    await saveEditorContent("/repo/a.ts", "text", localRef("/repo"), undefined, side);
    const [nonce] = useEditorStateStore.getState().files.get(side)!.pendingNonces;

    expect(consumeSavedContent(nonce!, side)).toBe("formatted text");
    expect(consumeSavedContent(nonce!, tab)).toBeUndefined();
  });
});

describe("worktrees held for saves", () => {
  test("are held per server: the same path on another server drains on its own", () => {
    const here = localRef("/repo");
    const there = worktreeRef(toServerId("other-server"), "/repo");
    const drained: string[] = [];
    holdWorktree(here);

    onWorktreeSavesDrained(there, () => drained.push("there"));
    onWorktreeSavesDrained(here, () => drained.push("here"));
    expect(drained).toEqual(["there"]);

    releaseWorktree(there);
    expect(drained).toEqual(["there"]);
    releaseWorktree(here);
    expect(drained).toEqual(["there", "here"]);
  });
});
