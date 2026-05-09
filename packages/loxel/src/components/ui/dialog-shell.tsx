import { type ReactNode, useEffect, useRef } from "react";

import { ModalErrorBoundary } from "@/components/ui/modal-error-boundary";
import { cn } from "@/lib/utils";

interface DialogShellProps {
  open: boolean;
  onCancel: () => void;
  className?: string;
  children: ReactNode;
}

export function DialogShell({ open, onCancel, className, children }: DialogShellProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <ModalErrorBoundary name="Dialog" onClose={onCancel}>
      <dialog
        ref={dialogRef}
        className={cn(
          "bg-popover text-foreground border-border m-auto rounded-lg border p-0 shadow-2xl backdrop:bg-black/50",
          className,
        )}
        onClose={onCancel}
        onClick={(e) => {
          if (e.target === e.currentTarget) onCancel();
        }}
      >
        {children}
      </dialog>
    </ModalErrorBoundary>
  );
}
