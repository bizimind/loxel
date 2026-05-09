import { type ReactNode, useEffect, useRef } from "react";

import { Button } from "@/components/ui/button";
import { DialogShell } from "@/components/ui/dialog-shell";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => confirmRef.current?.focus());
  }, [open]);

  return (
    <DialogShell open={open} onCancel={onCancel} className="w-80">
      <div className="px-4 pt-4 pb-2">
        <h3 className="text-foreground text-sm font-medium">{title}</h3>
        <p className="text-muted-foreground mt-1 text-xs leading-relaxed">{description}</p>
      </div>
      <div className="flex items-center justify-end gap-2 px-4 py-3">
        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button
          ref={confirmRef}
          variant={destructive ? "destructive" : "default"}
          size="sm"
          className="h-7 text-xs"
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
      </div>
    </DialogShell>
  );
}
