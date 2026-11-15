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
  /** Whether the current press started on the backdrop. A drag that starts inside the dialog and
   *  ends on the backdrop also clicks the dialog element, and must not close it. */
  const pressedBackdropRef = useRef(false);

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
          "bg-popover text-foreground border-border m-auto rounded-lg border p-0 shadow-(--shadow-dialog) backdrop:bg-black/20 dark:backdrop:bg-black/50",
          className,
        )}
        onClose={onCancel}
        onMouseDown={(e) => {
          pressedBackdropRef.current = e.target === e.currentTarget;
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget && pressedBackdropRef.current) onCancel();
        }}
      >
        {children}
      </dialog>
    </ModalErrorBoundary>
  );
}
