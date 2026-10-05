import { useCallback, useEffect, useRef } from "react";

import { cn } from "@/lib/utils";

export function InlineRenameInput({
  currentName,
  selectBaseName = false,
  className,
  onFinish,
  onCancel,
}: {
  currentName: string;
  /** Initially select only the name before its extension (file names), instead of all of it. */
  selectBaseName?: boolean;
  className?: string;
  onFinish: (newName: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelledRef = useRef(false);
  const blurReadyRef = useRef(false);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    const dotIdx = selectBaseName ? currentName.lastIndexOf(".") : -1;
    if (dotIdx > 0) {
      input.setSelectionRange(0, dotIdx);
    } else {
      input.select();
    }
    const timeout = window.setTimeout(() => {
      input.focus();
      blurReadyRef.current = true;
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [currentName, selectBaseName]);

  const handleSubmit = useCallback(() => {
    if (cancelledRef.current) return;
    const value = inputRef.current?.value.trim() ?? "";
    if (value && value !== currentName) {
      onFinish(value);
    } else {
      onCancel();
    }
  }, [currentName, onFinish, onCancel]);

  return (
    <input
      ref={inputRef}
      className={cn("bg-input min-w-0 flex-1 rounded px-1 text-xs outline-none", className)}
      defaultValue={currentName}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          handleSubmit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancelledRef.current = true;
          onCancel();
        }
      }}
      onBlur={() => {
        if (!blurReadyRef.current) return;
        handleSubmit();
      }}
    />
  );
}
