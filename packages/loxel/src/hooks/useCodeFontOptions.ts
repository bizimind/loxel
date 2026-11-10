import type { editor as monacoEditor } from "monaco-editor";
import { type RefObject, useEffect } from "react";

import { resolveFont } from "@/lib/font-settings";
import { useSettingsStore } from "@/store/settings-store";

type CodeFontOptions = Pick<monacoEditor.IEditorOptions, "fontFamily" | "fontSize">;

/** The code font options for `monaco.editor.create`. */
export function codeFontOptions(): CodeFontOptions {
  const { stack, size } = resolveFont(useSettingsStore.getState().fonts, "code");
  return { fontFamily: stack, fontSize: size };
}

/** Keep a mounted editor on the code font setting as it changes. */
export function useCodeFontOptions(editorRef: RefObject<monacoEditor.ICodeEditor | null>): void {
  const fontFamily = useSettingsStore((s) => resolveFont(s.fonts, "code").stack);
  const fontSize = useSettingsStore((s) => resolveFont(s.fonts, "code").size);
  useEffect(() => {
    editorRef.current?.updateOptions({ fontFamily, fontSize });
  }, [editorRef, fontFamily, fontSize]);
}
