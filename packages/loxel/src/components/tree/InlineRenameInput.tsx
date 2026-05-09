import { useCallback, useEffect, useRef } from "react";

export function InlineRenameInput({
  currentName,
  isDir,
  onFinish,
  onCancel,
}: {
  currentName: string;
  isDir: boolean;
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
    if (!isDir) {
      const dotIdx = currentName.lastIndexOf(".");
      if (dotIdx > 0) {
        input.setSelectionRange(0, dotIdx);
      } else {
        input.select();
      }
    } else {
      input.select();
    }
    const timeout = window.setTimeout(() => {
      input.focus();
      blurReadyRef.current = true;
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [currentName, isDir]);

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
      className="bg-input min-w-0 flex-1 rounded px-1 text-xs outline-none"
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
