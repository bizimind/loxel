import type { LucideIcon } from "lucide-react";
import { useCallback } from "react";
import type { FallbackProps } from "react-error-boundary";
import { ErrorBoundary } from "react-error-boundary";

import { frontendLog } from "@/lib/frontend-logger";
import { cn } from "@/lib/utils";

const log = frontendLog.child("ui");

function PanelErrorFallback({
  error,
  resetErrorBoundary,
  Icon,
  center,
}: FallbackProps & { Icon: LucideIcon; center: boolean }) {
  return (
    <div
      className={cn(
        "flex h-full w-full flex-col items-center justify-center gap-4 p-6",
        center ? "bg-editor-surface" : "bg-card",
      )}
    >
      <Icon
        className={cn("size-10", center ? "text-muted-foreground/50" : "text-muted-foreground/60")}
      />
      <div className="flex flex-col items-center gap-1.5">
        <p className="text-foreground text-center text-sm font-medium text-balance">
          Oops, something went wrong
        </p>
        <p
          className={cn(
            "max-w-xs text-center text-xs text-balance",
            center ? "text-muted-foreground" : "text-muted-foreground/80",
          )}
        >
          {error instanceof Error ? error.message : String(error)}
        </p>
      </div>
      <button
        onClick={resetErrorBoundary}
        className={cn(
          "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
          center
            ? "bg-muted hover:bg-muted/80 text-foreground"
            : "text-foreground bg-[var(--surface-0)] hover:bg-[var(--surface-0)]/80",
        )}
      >
        Retry
      </button>
    </div>
  );
}

export function PanelErrorBoundary({
  panelName,
  Icon,
  center,
  children,
}: {
  panelName: string;
  Icon: LucideIcon;
  center: boolean;
  children: React.ReactNode;
}) {
  const onError = useCallback(
    (error: unknown, info: React.ErrorInfo) => {
      log.error("Panel render error", {
        panel: panelName,
        error: error instanceof Error ? error : undefined,
        message: error instanceof Error ? undefined : String(error),
        componentStack: info.componentStack ?? undefined,
      });
    },
    [panelName],
  );

  const fallbackRender = useCallback(
    (props: FallbackProps) => <PanelErrorFallback {...props} Icon={Icon} center={center} />,
    [Icon, center],
  );

  return (
    <ErrorBoundary fallbackRender={fallbackRender} onError={onError}>
      {children}
    </ErrorBoundary>
  );
}
