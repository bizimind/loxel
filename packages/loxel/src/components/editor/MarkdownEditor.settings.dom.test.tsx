/**
 * Mounts the real MarkdownEditor component and checks that a change to the markdown output
 * settings recreates the Crepe editor, and that after the remount the source-preserving save
 * still leaves untouched blocks byte-identical while edited blocks use the new markers.
 */
import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { DockviewPanelApi } from "dockview-react";

import { DEFAULT_FORMATTING_SETTINGS } from "@/lib/formatting-model";
import { useEditorStateStore } from "@/store/editor-state";
import { useSettingsStore } from "@/store/settings-store";

const FILE_PATH = "/tmp/loxel-test/notes.md";
// Non-canonical on purpose: the serializer alone would rewrite the bullets and the heading.
const SOURCE = ["* one", "* two", "", "Title", "=====", "", "last paragraph", ""].join("\n");
// What the file becomes after a user edit in the first list item once bullets are `+`: the
// edited list takes the serializer form, the untouched heading and paragraph keep their bytes.
const EDITED = ["+ xone", "+ two", "", "Title", "=====", "", "last paragraph", ""].join("\n");

/** Creating a Crepe editor under happy-dom takes a couple of seconds; each test does it twice. */
const EDITOR_TEST_TIMEOUT_MS = 30_000;

const writeFileContent = jest.fn(async (options: { content: string }) => ({
  success: true,
  content: options.content,
}));

const originalClient = await import("@/api/client");
mock.module("@/api/client", () => ({
  ...originalClient,
  getFileContentByPath: async () => ({ content: SOURCE }),
  writeFileContent,
}));

const { MarkdownEditor, editorContentCache } = await import("./MarkdownEditor");

/** The parts of the dockview panel API the editor subscribes to. */
function fakePanelApi(): DockviewPanelApi {
  const noop = () => ({ dispose: () => {} });
  return {
    id: "panel-1",
    isActive: false,
    isGroupActive: false,
    onDidActiveChange: noop,
    onDidActiveGroupChange: noop,
    onDidGroupChange: noop,
  } as unknown as DockviewPanelApi;
}

function editorContent(): string | null {
  return useEditorStateStore.getState().files.get(FILE_PATH)?.getEditorContent?.() ?? null;
}

function renderEditor() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MarkdownEditor filePath={FILE_PATH} panelApi={fakePanelApi()} />
    </QueryClientProvider>,
  );
}

/** Paste plain text at the caret as a user edit (ProseMirror handles the event itself). */
function pasteText(container: HTMLElement, text: string): void {
  const pm = container.querySelector(".ProseMirror");
  if (!pm) throw new Error("editor not mounted");
  fireEvent.paste(pm, {
    clipboardData: { getData: (type: string) => (type === "text/plain" ? text : "") },
  });
}

beforeEach(() => {
  useSettingsStore.setState((s) => ({
    editor: { ...s.editor, formatting: { ...DEFAULT_FORMATTING_SETTINGS, enabled: false } },
  }));
  editorContentCache.clear();
  writeFileContent.mockClear();
});

afterEach(() => {
  cleanup();
  useEditorStateStore.getState().closeFile(FILE_PATH);
});

describe("MarkdownEditor markdown output settings", () => {
  test(
    "a settings change remounts the editor and keeps untouched blocks byte-identical",
    async () => {
      const { container } = renderEditor();
      await waitFor(() => expect(editorContent()).toBe(SOURCE));
      const before = container.querySelector(".milkdown");
      expect(before).not.toBeNull();

      act(() => {
        useSettingsStore.getState().updateMarkdownOutput({ bullet: "+" });
      });
      await waitFor(() => {
        const after = container.querySelector(".milkdown");
        expect(after).not.toBeNull();
        expect(after).not.toBe(before);
      });
      // The recreated editor still serializes the untouched file to its source bytes.
      await waitFor(() => expect(editorContent()).toBe(SOURCE));

      // Under happy-dom the caret sits at the document start (inside "one"), so a user edit lands
      // in the list: that block is rewritten with the new `+` bullets, nothing else changes.
      pasteText(container, "x");
      await waitFor(() => expect(editorContent()).toBe(EDITED));

      // Autosave posts exactly that content.
      await waitFor(() => expect(writeFileContent).toHaveBeenCalled());
      expect(writeFileContent.mock.calls[0]?.[0].content).toBe(EDITED);
    },
    EDITOR_TEST_TIMEOUT_MS,
  );

  test(
    "re-hydrating identical settings does not remount the editor",
    async () => {
      const { container } = renderEditor();
      await waitFor(() => expect(editorContent()).toBe(SOURCE));
      const before = container.querySelector(".milkdown");

      act(() => {
        useSettingsStore
          .getState()
          .updateMarkdownOutput({ ...DEFAULT_FORMATTING_SETTINGS.markdownOutput });
      });
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
      expect(container.querySelector(".milkdown")).toBe(before);
    },
    EDITOR_TEST_TIMEOUT_MS,
  );
});
