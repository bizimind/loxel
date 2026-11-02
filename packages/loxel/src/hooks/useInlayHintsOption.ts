import type { editor as monacoEditor } from "monaco-editor";
import { type RefObject, useEffect } from "react";

import { type InlayHintsMode, useSettingsStore } from "@/store/settings-store";

function toOption(enabled: InlayHintsMode): monacoEditor.IEditorInlayHintsOptions {
  return { enabled };
}

/**
 * The `inlayHints` option for `monaco.editor.create`, so an editor created with hints off doesn't
 * ask its language server for them, as Monaco's controller would if told only after `create`.
 */
export function inlayHintsOption(): monacoEditor.IEditorInlayHintsOptions {
  return toOption(useSettingsStore.getState().editor.inlayHints);
}

/** Keep a mounted editor on the inlay hints setting as it changes. */
export function useInlayHintsOption(editorRef: RefObject<monacoEditor.ICodeEditor | null>): void {
  const enabled = useSettingsStore((s) => s.editor.inlayHints);
  useEffect(() => {
    editorRef.current?.updateOptions({ inlayHints: toOption(enabled) });
  }, [editorRef, enabled]);
}
