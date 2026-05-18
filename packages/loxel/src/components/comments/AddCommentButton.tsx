import { MessageSquarePlusIcon } from "lucide-react";
import type { editor } from "monaco-editor";
import { useEffect, useRef } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface AddCommentButtonProps {
  /** The editor instance to track selection position */
  editorInstance: editor.IStandaloneCodeEditor | null;
  /** Current selection or caret position (null = hidden) */
  selection: { startLine: number; endLine: number } | null;
  /** Subscribe to scroll for repositioning */
  subscribeToScroll: (cb: (left: number, right: number) => void) => () => void;
  /** Which scroll value to use */
  scrollSide: "left" | "right";
  /** Which horizontal edge to anchor the button to */
  side: "left" | "right";
  onClick: () => void;
}

const LINE_HEIGHT = 22;

/**
 * Floating comment button that appears next to the caret or selection.
 * Positioned at the last line of the selection, vertically centered.
 */
export function AddCommentButton({
  editorInstance,
  selection,
  subscribeToScroll,
  scrollSide,
  side,
  onClick,
}: AddCommentButtonProps) {
  const buttonRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!selection || !editorInstance) return;

    const updatePosition = (leftScroll: number, rightScroll: number) => {
      const el = buttonRef.current;
      if (!el) return;
      const scrollTop = scrollSide === "left" ? leftScroll : rightScroll;
      const lineTop = editorInstance.getTopForLineNumber(selection.endLine) - scrollTop;
      el.style.transform = `translateY(${lineTop}px)`;
    };

    return subscribeToScroll(updatePosition);
  }, [selection, editorInstance, subscribeToScroll, scrollSide]);

  if (!selection || !editorInstance) return null;

  const posClass = side === "left" ? "left-0" : "right-0";

  return (
    <div
      ref={buttonRef}
      className={cn(
        "pointer-events-auto absolute",
        posClass,
        "z-20 flex items-center will-change-transform",
      )}
      style={{ top: 0, height: LINE_HEIGHT }}
    >
      <Button
        variant="default"
        size="icon-xs"
        className="bg-primary mx-px size-5 rounded shadow hover:brightness-125"
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
        title="Add comment"
      >
        <MessageSquarePlusIcon className="text-primary-foreground size-3.5" />
      </Button>
    </div>
  );
}
