import { afterEach, describe, expect, jest, test } from "bun:test";

import { act, cleanup, render } from "@testing-library/react";
import type { editor as monacoEditor } from "monaco-editor";
import { useRef } from "react";

import { DEFAULT_EDITOR_SETTINGS, useSettingsStore } from "@/store/settings-store";

import { inlayHintsOption, useInlayHintsOption } from "./useInlayHintsOption";

function Harness({ editor }: { editor: monacoEditor.ICodeEditor | null }) {
  const editorRef = useRef(editor);
  useInlayHintsOption(editorRef);
  return null;
}

function fakeEditor() {
  const updateOptions = jest.fn();
  return { editor: { updateOptions } as unknown as monacoEditor.ICodeEditor, updateOptions };
}

describe("useInlayHintsOption", () => {
  afterEach(() => {
    cleanup();
    useSettingsStore.getState().setEditorInlayHints(DEFAULT_EDITOR_SETTINGS.inlayHints);
  });

  test("defaults to on", () => {
    expect(inlayHintsOption()).toEqual({ enabled: "on" });
  });

  test("the create option follows the setting", () => {
    useSettingsStore.getState().setEditorInlayHints("off");
    expect(inlayHintsOption()).toEqual({ enabled: "off" });
  });

  test("a mounted editor follows each change", () => {
    const { editor, updateOptions } = fakeEditor();
    render(<Harness editor={editor} />);
    for (const mode of ["offUnlessPressed", "onUnlessPressed", "off", "on"] as const) {
      act(() => useSettingsStore.getState().setEditorInlayHints(mode));
      expect(updateOptions).toHaveBeenLastCalledWith({ inlayHints: { enabled: mode } });
    }
  });

  test("does nothing before the editor exists", () => {
    render(<Harness editor={null} />);
    act(() => useSettingsStore.getState().setEditorInlayHints("off"));
  });
});
