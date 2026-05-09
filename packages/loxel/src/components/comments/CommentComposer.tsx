import type { editor } from "monaco-editor";

import { SendIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { CreateThreadRequest } from "@/api/review-model";

import { Button } from "@/components/ui/button";
import { createContentAnchor } from "@/lib/content-anchor";
import { frontendLog } from "@/lib/frontend-logger";
import { useCommentStore } from "@/store/comments";

interface CommentComposerProps {
  /** The editor instance for position computation */
  editorInstance: editor.IStandaloneCodeEditor | null;
  /** Subscribe to scroll for repositioning */
  subscribeToScroll: (cb: (left: number, right: number) => void) => () => void;
  /** Which scroll value to use */
  scrollSide: "left" | "right";
  /** Active review ID for the thread being created */
  reviewId: string;
  /** File path for the thread */
  filePath: string;
  /** File lines for computing content anchors */
  fileLines: string[];
}

export function CommentComposer({
  editorInstance,
  subscribeToScroll,
  scrollSide,
  reviewId,
  filePath,
  fileLines,
}: CommentComposerProps) {
  const pendingAnchor = useCommentStore((s) => s.pendingAnchor);
  const setPendingAnchor = useCommentStore((s) => s.setPendingAnchor);
  const createThread = useCommentStore((s) => s.createThread);

  const containerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Position the composer at the anchor's endLine using fixed coordinates
  // so the portal escapes any overflow:hidden containers
  useEffect(() => {
    if (!pendingAnchor || !editorInstance) return;

    const updatePosition = (leftScroll: number, rightScroll: number) => {
      const el = containerRef.current;
      if (!el) return;
      const editorDom = editorInstance.getDomNode();
      if (!editorDom) return;
      const rect = editorDom.getBoundingClientRect();
      const scrollTop = scrollSide === "left" ? leftScroll : rightScroll;
      const lineTop = editorInstance.getTopForLineNumber(pendingAnchor.endLine + 1) - scrollTop;
      el.style.top = `${rect.top + lineTop}px`;
      el.style.right = `${window.innerWidth - rect.right + 8}px`;
    };

    return subscribeToScroll(updatePosition);
  }, [pendingAnchor, editorInstance, subscribeToScroll, scrollSide]);

  // Focus textarea on mount
  useEffect(() => {
    if (pendingAnchor) {
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [pendingAnchor]);

  const handleSubmit = useCallback(async () => {
    if (!body.trim() || !pendingAnchor) return;
    setSubmitting(true);
    try {
      const contentAnchor = createContentAnchor(
        fileLines,
        pendingAnchor.startLine,
        pendingAnchor.endLine,
      );
      const data: CreateThreadRequest = {
        reviewId,
        filePath,
        createdSide: pendingAnchor.side,
        contentAnchor,
        startLine: pendingAnchor.startLine,
        endLine: pendingAnchor.endLine,
        body: body.trim(),
      };
      await createThread(data);
      setBody("");
    } catch (err) {
      frontendLog
        .child("ui")
        .error("Failed to create thread", { error: err instanceof Error ? err : undefined });
    } finally {
      setSubmitting(false);
    }
  }, [body, pendingAnchor, reviewId, filePath, fileLines, createThread]);

  const handleCancel = useCallback(() => {
    setPendingAnchor(null);
    setBody("");
  }, [setPendingAnchor]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        handleCancel();
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleCancel, handleSubmit],
  );

  if (!pendingAnchor) return null;

  return createPortal(
    <div ref={containerRef} className="fixed z-[9999] will-change-[top]" style={{ width: 440 }}>
      <div className="bg-popover border-border rounded-lg border shadow-2xl">
        {/* Header */}
        <div className="border-border flex items-center justify-between border-b px-3 py-1.5">
          <span className="text-muted-foreground text-[11px]">
            Comment on L{pendingAnchor.startLine}
            {pendingAnchor.endLine > pendingAnchor.startLine && `–L${pendingAnchor.endLine}`}
            <span className="text-muted-foreground/60 ml-1">
              ({pendingAnchor.side === "old" ? "parent" : "current"})
            </span>
          </span>
          <Button variant="ghost" size="icon-xs" onClick={handleCancel} title="Cancel">
            <XIcon className="size-3" />
          </Button>
        </div>

        {/* Body */}
        <div className="p-2">
          <textarea
            ref={textareaRef}
            className="bg-muted border-border text-foreground placeholder:text-muted-foreground w-full resize-none rounded border p-2 text-xs focus:ring-1 focus:ring-[var(--ring)] focus:outline-none"
            rows={5}
            placeholder="Write a comment..."
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={submitting}
          />
        </div>

        {/* Footer */}
        <div className="border-border flex items-center justify-between border-t px-3 py-1.5">
          <span className="text-muted-foreground/60 text-[10px]">
            {/Mac|iPhone/.test(navigator.userAgent) ? "Cmd" : "Ctrl"}+Enter to submit
          </span>
          <Button
            variant="default"
            size="sm"
            className="h-6 gap-1 px-2 text-[11px]"
            onClick={handleSubmit}
            disabled={!body.trim() || submitting}
          >
            <SendIcon className="size-3" />
            Comment
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
