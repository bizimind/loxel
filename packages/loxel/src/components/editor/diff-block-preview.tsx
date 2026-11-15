/**
 * Renders ```diff and ```patch fenced code blocks as a diff view in Crepe's code block preview
 * panel, built from the diff viewer's hunk components over `parseUnifiedDiff`'s model.
 *
 * The preview is view-only: it never touches the code block's text, so the markdown source (and
 * the source-preserving save) is unaffected, and the code stays editable above it.
 *
 * The panel inserts previews as sanitized HTML, so the view is rendered to static markup and has
 * no React state or listeners. It holds both layouts; the editor container's
 * `data-diff-view-mode` attribute (the global `diffViewMode` setting, shared with the diff
 * panels) picks one in CSS, and `handleDiffBlockClick`, delegated from the container, makes the
 * Unified/Split buttons set that setting. A per-block choice would be lost whenever the panel
 * re-renders the preview, which it does on every edit of the block. The "Open in diff panel"
 * button carries no text: the handler reads the block's text from the document when clicked.
 */
import type { EditorView } from "@milkdown/kit/prose/view";
import { ExternalLinkIcon } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";

import type { DiffInfo, FileDiff } from "@/api/diff-model";
import { fileDiffPath } from "@/api/diff-model";
import { DiffViewModeToggle } from "@/components/diff-viewer/DiffToolbar";
import { FileDiffHeader, fileDiffTitle } from "@/components/diff-viewer/FileDiffHeader";
import { HunkSection } from "@/components/diff-viewer/HunkBasedDiffView";
import { buildFileInlineSegments } from "@/components/diff-viewer/HunkLineContent";
import type { RenderPreview } from "@/components/editor/code-block-preview";
import { frontendLog } from "@/lib/frontend-logger";
import { parseUnifiedDiff } from "@/lib/parse-unified-diff";
import { type DiffViewMode, useUIStore } from "@/store/ui";

import "@/styles/diff-block-preview.css";

const VIEW_MODES = ["unified", "split"] as const satisfies readonly DiffViewMode[];
const OPEN_IN_PANEL_ATTR = "data-diff-block-open";

/**
 * Crepe `renderPreview` for diff fences: a diff view, or `null` (no preview panel, the plain code
 * block) when the text holds no diff or the view fails to render.
 */
export const renderDiffPreview: RenderPreview = (_language, content) => {
  try {
    const diff = parseUnifiedDiff(content);
    return diff && renderToStaticMarkup(<DiffBlockView diff={diff} />);
  } catch (error) {
    frontendLog
      .child("ui")
      .error("Failed to render diff block preview", {
        error: error instanceof Error ? error : undefined,
      });
    return null;
  }
};

/**
 * Click handler for the markdown editor's container: a diff block's Unified/Split buttons set the
 * global diff view mode, and its "Open in diff panel" button calls `openInPanel` with the code
 * block's node view element (see {@link codeBlockText}). Accepts React and DOM events.
 */
export function handleDiffBlockClick(
  event: { target: EventTarget | null },
  openInPanel: (codeBlock: Element) => void,
): void {
  if (!(event.target instanceof Element)) return;
  if (event.target.closest(`[${OPEN_IN_PANEL_ATTR}]`)) {
    const codeBlock = event.target.closest(".milkdown-code-block");
    if (codeBlock) openInPanel(codeBlock);
    return;
  }
  const option = event.target
    .closest("[data-diff-view-mode-option]")
    ?.getAttribute("data-diff-view-mode-option");
  const mode = VIEW_MODES.find((m) => m === option);
  if (mode) useUIStore.getState().setDiffViewMode(mode);
}

/** The text of the code block whose node view element is `codeBlock`; null for anything else. */
export function codeBlockText(view: EditorView, codeBlock: Element): string | null {
  if (!view.dom.contains(codeBlock)) return null;
  // The node view has no content DOM, so its offset 0 maps to the start of the block's text.
  const node = view.state.doc.resolve(view.posAtDOM(codeBlock, 0)).parent;
  return node.type.name === "code_block" ? node.textContent : null;
}

/** A parsed diff with both layouts, for static rendering into the preview panel. */
export function DiffBlockView({ diff }: { diff: DiffInfo }) {
  const additions = diff.files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = diff.files.reduce((sum, file) => sum + file.deletions, 0);
  const fileCount = diff.files.filter((file) => fileDiffPath(file) !== "").length;
  return (
    <div className="loxel-diff-block flex flex-col gap-2 font-(family-name:--loxel-font-code) text-xs">
      <div className="flex items-center gap-2 font-sans text-[10px]">
        {fileCount > 1 && <span className="text-muted-foreground">{fileCount} files</span>}
        {additions > 0 && <span className="text-diff-add-text">+{additions}</span>}
        {deletions > 0 && <span className="text-diff-del-text">-{deletions}</span>}
        <div className="flex-1" />
        <button
          type="button"
          {...{ [OPEN_IN_PANEL_ATTR]: "" }}
          title="Open in diff panel"
          className="text-muted-foreground hover:text-foreground hover:bg-muted flex h-6 items-center gap-1 rounded-md px-2 transition-colors"
        >
          <ExternalLinkIcon className="size-3" />
          Open in diff panel
        </button>
        <DiffViewModeToggle />
      </div>
      {diff.files.map((file, i) => (
        <DiffBlockFile key={i} file={file} />
      ))}
    </div>
  );
}

function DiffBlockFile({ file }: { file: FileDiff }) {
  const inlineSegments = buildFileInlineSegments(file.hunks);
  const path = fileDiffPath(file);
  return (
    <div className="border-border overflow-hidden rounded-md border">
      {path !== "" && <FileDiffHeader file={file} title={fileDiffTitle(file)} />}
      {file.hunks.length === 0 && (
        <div className="text-muted-foreground px-3 py-1.5 font-sans">
          {file.isBinary ? "Binary file not shown" : "No content changes"}
        </div>
      )}
      {file.hunks.length > 0 &&
        VIEW_MODES.map((mode) => (
          <div key={mode} data-diff-view={mode} className="overflow-x-auto">
            {file.hunks.map((hunk, i) => (
              <HunkSection
                key={i}
                hunk={hunk}
                viewMode={mode}
                highlighted={false}
                inlineSegments={inlineSegments[i]}
              />
            ))}
          </div>
        ))}
    </div>
  );
}
