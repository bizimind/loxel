import type { ReactNode } from "react";

import { ErrorBoundary } from "react-error-boundary";

import { frontendLog } from "@/lib/frontend-logger";

const log = frontendLog.child("ui");

interface ModalErrorBoundaryProps {
  name: string;
  onClose: () => void;
  children: ReactNode;
}

export function ModalErrorBoundary({ name, onClose, children }: ModalErrorBoundaryProps) {
  return (
    <ErrorBoundary
      fallbackRender={({ error, resetErrorBoundary }) => (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50">
          <div className="bg-popover border-border flex w-80 flex-col items-center gap-3 rounded-lg border p-8 shadow-2xl">
            <p className="text-foreground text-sm font-medium">{name} encountered an error</p>
            <p className="text-muted-foreground max-w-xs text-center text-xs text-balance">
              {error instanceof Error ? error.message : String(error)}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={resetErrorBoundary}
                className="bg-muted hover:bg-muted/80 text-foreground rounded-md px-3 py-1.5 text-xs font-medium transition-colors"
              >
                Retry
              </button>
              <button
                type="button"
                onClick={onClose}
                className="text-muted-foreground hover:text-foreground rounded-md px-3 py-1.5 text-xs transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
      onError={(error, info) => {
        log.error(`${name} render error`, {
          error: error instanceof Error ? error : undefined,
          message: error instanceof Error ? undefined : String(error),
          componentStack: info.componentStack ?? undefined,
        });
      }}
    >
      {children}
    </ErrorBoundary>
  );
}
