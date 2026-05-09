import type React from "react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export function EmptyValue() {
  return <span className="text-muted-foreground">-</span>;
}

export function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <span role="alert" className="text-destructive mt-0.5 block text-[11px] leading-tight">
      {message}
    </span>
  );
}

export function FieldInput({ className, ...props }: React.ComponentProps<typeof Input>) {
  return <Input className={cn("h-7 px-2 py-0 text-xs leading-none", className)} {...props} />;
}

export function FieldTextarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(
        "border-input placeholder:text-muted-foreground focus-visible:ring-ring min-h-14 w-full resize-y rounded-md border bg-[var(--surface-2)] px-2 py-1.5 text-xs leading-snug shadow-sm transition-colors focus-visible:ring-1 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export function FieldSelect({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      className={cn(
        "border-input bg-background text-foreground focus-visible:ring-ring h-7 w-full rounded-md border px-2 text-xs leading-none shadow-sm focus-visible:ring-1 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
