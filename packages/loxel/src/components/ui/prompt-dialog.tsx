import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { DialogShell } from "@/components/ui/dialog-shell";
import { Input } from "@/components/ui/input";

interface PromptDialogProps {
  open: boolean;
  title: string;
  description?: ReactNode;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

export function PromptDialog({
  open,
  title,
  description,
  defaultValue = "",
  placeholder,
  confirmLabel = "OK",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
}: PromptDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(defaultValue);

  useEffect(() => {
    if (!open) return;
    setValue(defaultValue);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      if (defaultValue) el.select();
    });
  }, [open, defaultValue]);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!value) return;
      onConfirm(value);
    },
    [onConfirm, value],
  );

  return (
    <DialogShell open={open} onCancel={onCancel} className="w-80">
      <form onSubmit={handleSubmit}>
        <div className="px-4 pt-4 pb-2">
          <h3 className="text-foreground text-sm font-medium">{title}</h3>
          {description && (
            <p className="text-muted-foreground mt-1 text-xs leading-relaxed">{description}</p>
          )}
          <Input
            ref={inputRef}
            value={value}
            placeholder={placeholder}
            onChange={(e) => setValue(e.target.value)}
            className="mt-3 h-8 text-xs"
          />
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={onCancel}
          >
            {cancelLabel}
          </Button>
          <Button
            type="submit"
            variant="default"
            size="sm"
            className="h-7 text-xs"
            disabled={!value}
          >
            {confirmLabel}
          </Button>
        </div>
      </form>
    </DialogShell>
  );
}
