import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";

import type { FileDiff } from "@/api/diff-model";
import type { DiffSide } from "@/components/diff/SideBySideDiffView";
import { useEditorStateStore } from "@/store/editor-state";
import { getWorktreeUI } from "@/store/worktree-ui";
import { useWorktreeStore } from "@/store/worktrees";

const WT = "/repo";

/** What the view last passed to the side-by-side view */
let rendered: { hunks: FileDiff["hunks"]; oldSide: DiffSide; newSide: DiffSide } | null = null;
mock.module("@/components/diff/SideBySideDiffView", () => ({
  SideBySideDiffView: (props: NonNullable<typeof rendered> & { isLoading?: boolean }) => {
    rendered = props.isLoading ? null : props;
    return null;
  },
}));
mock.module("monaco-editor", () => ({ Uri: { from: (parts: unknown) => parts } }));
mock.module("@/lib/monaco-theme", () => ({ toMonacoLanguage: (lang: string) => lang }));
mock.module("@/lib/monaco-save-action", () => ({ addSaveAction: () => {} }));
const saveEditorContent = jest.fn(async () => {});
mock.module("@/lib/save-editor-content", () => ({ saveEditorContent }));

/** The file at HEAD and on disk */
let headContent = "";
let diskContent = "";
const originalClient = await import("@/api/client");
mock.module("@/api/client", () => ({
  ...originalClient,
  getFileContent: async () => ({ lines: headContent.split("\n") }),
  getFileContentByPath: async () => ({ content: diskContent }),
  getDiagnostics: async () => ({ diagnostics: [] }),
}));

const { GitSideBySideDiffView } = await import("./GitSideBySideDiffView");

const FILE: FileDiff = {
  oldPath: "src/a.ts",
  newPath: "src/a.ts",
  status: "modified",
  hunks: [],
  isBinary: false,
  additions: 1,
  deletions: 1,
};

interface ViewProps {
  file?: FileDiff;
  worktreePath?: string;
  onWorkingTreeFileChange?: () => void;
}

function viewElement(props: ViewProps) {
  return (
    <GitSideBySideDiffView
      file={props.file ?? FILE}
      oldRef="abc1234"
      newRef={undefined}
      worktreePath={props.worktreePath ?? WT}
      onWorkingTreeFileChange={props.onWorkingTreeFileChange}
    />
  );
}

function renderView(props: ViewProps = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>{viewElement(props)}</QueryClientProvider>,
  );
  const rerenderView = (next: ViewProps) =>
    view.rerender(
      <QueryClientProvider client={queryClient}>{viewElement(next)}</QueryClientProvider>,
    );
  return { ...view, queryClient, rerenderView };
}

/** The hunk lines as `+`/`-`/` ` prefixed text, to compare whole diffs at a glance */
function diffLines(): string[] {
  return (rendered?.hunks ?? []).flatMap((hunk) =>
    hunk.lines.map((line) => {
      if (line.type === "add") return `+${line.content}`;
      if (line.type === "delete") return `-${line.content}`;
      return ` ${line.content}`;
    }),
  );
}

describe("GitSideBySideDiffView", () => {
  beforeEach(() => {
    rendered = null;
    saveEditorContent.mockClear();
    headContent = "one\ntwo\nthree\n";
    diskContent = "one\n2\nthree\n";
    useWorktreeStore.setState({ activeWorktreePath: WT });
    getWorktreeUI(WT).getState().setSelectedDiffFile("src/a.ts");
  });
  afterEach(cleanup);

  test("makes the working-tree side editable and diffs it as it is edited", async () => {
    renderView();
    await waitFor(() => expect(diffLines()).toEqual([" one", "-two", "+2", " three", " "]));
    expect(rendered?.newSide.editable?.content).toBe("one\n2\nthree\n");
    expect(rendered?.oldSide.editable).toBeUndefined();

    act(() => rendered?.newSide.editable?.onContentChange("one\ntwo\nthree\nfour\n"));
    await waitFor(() => expect(diffLines()).toEqual([" one", " two", " three", "+four", " "]));
  });

  test("diffs a CRLF file by its lines, not its line endings", async () => {
    headContent = "one\r\ntwo\r\n";
    diskContent = "one\r\n2\r\n";
    renderView();
    await waitFor(() => expect(diffLines()).toEqual([" one", "-two", "+2", " "]));
  });

  test("diffs an added file as all added lines", async () => {
    diskContent = "new\nfile\n";
    renderView({ file: { ...FILE, status: "added" } });
    await waitFor(() => expect(diffLines()).toEqual(["+new", "+file"]));
    expect(rendered?.oldSide.lines).toEqual([]);
  });

  test("stays editable when the file is deleted while shown", async () => {
    const { rerenderView } = renderView();
    await waitFor(() => expect(rendered).not.toBeNull());
    act(() => rendered?.newSide.editable?.onContentChange("unsaved\n"));

    rerenderView({ file: { ...FILE, status: "deleted" } });
    expect(rendered?.newSide.editable?.content).toBe("unsaved\n");
  });

  test("leaves a file deleted before it was shown read-only", async () => {
    renderView({ file: { ...FILE, status: "deleted" } });
    await waitFor(() => expect(rendered).not.toBeNull());
    expect(rendered?.newSide.editable).toBeUndefined();
  });

  test("keeps an edited file selected until the view goes away", async () => {
    const { unmount } = renderView();
    await waitFor(() => expect(rendered).not.toBeNull());
    expect(getWorktreeUI(WT).getState().editedDiffFile).toBeNull();

    // Undoing the change makes the file match HEAD, which drops it from the git diff.
    act(() => rendered?.newSide.editable?.onContentChange(headContent));
    expect(getWorktreeUI(WT).getState().editedDiffFile).toBe("src/a.ts");
    await waitFor(() => expect(rendered?.hunks).toEqual([]));

    unmount();
    expect(getWorktreeUI(WT).getState().editedDiffFile).toBeNull();
  });

  test("reports changes of the file on disk, not its first load", async () => {
    const onWorkingTreeFileChange = jest.fn();
    const { queryClient } = renderView({ onWorkingTreeFileChange });
    await waitFor(() => expect(rendered).not.toBeNull());
    expect(onWorkingTreeFileChange).not.toHaveBeenCalled();

    diskContent = "one\n2\n3\n";
    await act(() => queryClient.invalidateQueries());
    await waitFor(() => expect(onWorkingTreeFileChange).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(rendered?.newSide.editable?.content).toBe("one\n2\n3\n"));
  });

  test("leaves another worktree's uncommitted changes read-only", async () => {
    renderView({ worktreePath: "/other" });
    await waitFor(() => expect(rendered).not.toBeNull());
    expect(rendered?.newSide.editable).toBeUndefined();
    expect(useEditorStateStore.getState().files.size).toBe(0);
  });
});
