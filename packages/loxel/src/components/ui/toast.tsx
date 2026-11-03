import { XIcon } from "lucide-react";
import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";

interface Toast {
  id: number;
  message: string;
  variant: "error" | "info";
}

const AUTO_DISMISS_MS = 5_000;

let nextId = 1;
let listeners: Array<() => void> = [];
let currentToasts: Toast[] = [];
const dismissTimers = new Map<number, ReturnType<typeof setTimeout>>();

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}

function getToasts() {
  return currentToasts;
}

export function showToast(message: string, variant: "error" | "info" = "error") {
  const id = nextId++;
  currentToasts = [...currentToasts, { id, message, variant }];
  notify();
  scheduleDismiss(id);
}

function scheduleDismiss(id: number) {
  clearDismissTimer(id);
  dismissTimers.set(
    id,
    setTimeout(() => dismissToast(id), AUTO_DISMISS_MS),
  );
}

function clearDismissTimer(id: number) {
  clearTimeout(dismissTimers.get(id));
  dismissTimers.delete(id);
}

function dismissToast(id: number) {
  clearDismissTimer(id);
  currentToasts = currentToasts.filter((t) => t.id !== id);
  notify();
}

export function ToastContainer() {
  const toasts = useSyncExternalStore(subscribe, getToasts);

  // Mounted even when empty, so screen readers already track it when a toast is added.
  return createPortal(
    <div aria-live="polite" className="fixed right-4 bottom-4 z-[9998] flex flex-col gap-2">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>,
    document.body,
  );
}

function ToastItem({ toast }: { toast: Toast }) {
  return (
    // While the pointer or keyboard focus is on a toast it stays up, so a long message can be read.
    <div
      onMouseEnter={() => clearDismissTimer(toast.id)}
      onMouseLeave={() => scheduleDismiss(toast.id)}
      onFocus={() => clearDismissTimer(toast.id)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) scheduleDismiss(toast.id);
      }}
      className={cn(
        "animate-in slide-in-from-bottom-2 fade-in bg-popover border-border flex max-w-80 items-start gap-2 rounded-lg border px-3 py-2 shadow-lg",
        toast.variant === "error" && "border-destructive/30",
      )}
    >
      {/* Errors from git and wt can span several lines (hook output, paths): keep their breaks. */}
      <span
        role={toast.variant === "error" ? "alert" : "status"}
        className={cn(
          "max-h-60 flex-1 overflow-y-auto text-xs break-words whitespace-pre-wrap",
          toast.variant === "error" ? "text-destructive" : "text-foreground",
        )}
      >
        {toast.message}
      </span>
      <button
        type="button"
        aria-label="Dismiss"
        title="Dismiss"
        className="text-muted-foreground hover:text-foreground shrink-0 cursor-pointer"
        onClick={() => dismissToast(toast.id)}
      >
        <XIcon className="size-3" />
      </button>
    </div>
  );
}
