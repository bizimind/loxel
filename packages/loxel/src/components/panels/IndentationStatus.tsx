import { useActionHandler } from "@/hooks/useActionHandler";
import { useActiveEditorFilePath } from "@/hooks/useActiveEditorFilePath";
import { describeIndentation } from "@/lib/indentation-status";
import { useEditorIndentationStore } from "@/store/editor-indentation";

/**
 * The active code editor's indentation and where it came from, and its line endings. Clicking the
 * indentation opens Change Indentation.
 */
export function IndentationStatus() {
  const filePath = useActiveEditorFilePath();
  const entry = useEditorIndentationStore((s) => (filePath ? s.byFile.get(filePath) : undefined));
  const dispatch = useActionHandler();
  if (!entry) return null;

  const { label, source, details } = describeIndentation(entry.resolution);
  return (
    <>
      <button
        type="button"
        onClick={() => dispatch("editor.changeIndentation")}
        title={[...details, "Click to change"].join("\n")}
        className="text-muted-foreground hover:text-foreground flex cursor-pointer items-center gap-1 transition-colors"
      >
        {label}
        <span className="text-muted-foreground/70">({source})</span>
      </button>
      <span title="Line endings">{entry.eol}</span>
    </>
  );
}
