import { XIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";

interface Toast {
  id: number;
  message: string;
  variant: "error" | "info";
}

let nextId = 1;
let listeners: Array<(toasts: Toast[]) => void> = [];
let currentToasts: Toast[] = [];

function notify() {
  for (const listener of listeners) listener(currentToasts);
}

export function showToast(message: string, variant: "error" | "info" = "error") {
  const id = nextId++;
  currentToasts = [...currentToasts, { id, message, variant }];
  notify();
  // Auto-dismiss after 5 seconds
  setTimeout(() => dismissToast(id), 5_000);
}

function dismissToast(id: number) {
  currentToasts = currentToasts.filter((t) => t.id !== id);
  notify();
}

export function ToastContainer() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    listeners.push(setToasts);
    return () => {
      listeners = listeners.filter((l) => l !== setToasts);
    };
  }, []);

  if (toasts.length === 0) return null;

  return createPortal(
    <div className="fixed right-4 bottom-4 z-[9998] flex flex-col gap-2">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>,
    document.body,
  );
}

function ToastItem({ toast }: { toast: Toast }) {
  const handleDismiss = useCallback(() => dismissToast(toast.id), [toast.id]);

  return (
    <div
      className={cn(
        "animate-in slide-in-from-bottom-2 fade-in bg-popover border-border flex max-w-80 items-start gap-2 rounded-lg border px-3 py-2 shadow-lg",
        toast.variant === "error" && "border-destructive/30",
      )}
    >
      <span
        className={cn(
          "flex-1 text-xs",
          toast.variant === "error" ? "text-destructive" : "text-foreground",
        )}
      >
        {toast.message}
      </span>
      <button
        className="text-muted-foreground hover:text-foreground shrink-0 cursor-pointer"
        onClick={handleDismiss}
      >
        <XIcon className="size-3" />
      </button>
    </div>
  );
}
