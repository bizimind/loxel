import type { ReactNode } from "react";
import { create } from "zustand";

import { ConfirmDialog } from "./confirm-dialog";

export interface ConfirmationOptions {
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

interface PendingConfirmation extends ConfirmationOptions {
  resolve: (confirmed: boolean) => void;
}

const usePendingConfirmation = create<{ pending: PendingConfirmation | null }>(() => ({
  pending: null,
}));

/**
 * Ask the user to confirm an action from imperative code (hooks, keyboard handlers) that has
 * no place to render a dialog. Resolves `true` on confirm, `false` on cancel or Esc. Only one
 * confirmation is shown at a time; a newer request cancels the one still pending.
 */
export function requestConfirmation(options: ConfirmationOptions): Promise<boolean> {
  return new Promise((resolve) => {
    usePendingConfirmation.getState().pending?.resolve(false);
    usePendingConfirmation.setState({ pending: { ...options, resolve } });
  });
}

/** Renders the dialog for `requestConfirmation`. Mount once, at the app root. */
export function ConfirmDialogHost() {
  const pending = usePendingConfirmation((s) => s.pending);
  const settle = (confirmed: boolean) => {
    if (!pending) return;
    usePendingConfirmation.setState({ pending: null });
    pending.resolve(confirmed);
  };
  return (
    <ConfirmDialog
      open={pending !== null}
      title={pending?.title ?? ""}
      description={pending?.description ?? ""}
      confirmLabel={pending?.confirmLabel}
      cancelLabel={pending?.cancelLabel}
      destructive={pending?.destructive}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  );
}
