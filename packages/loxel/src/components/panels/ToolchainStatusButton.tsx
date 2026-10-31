import { cn } from "@/lib/utils";

/** A language toolchain's status bar item: shows the toolchain and opens its picker. */
export function ToolchainStatusButton({
  label,
  tooltip,
  warning,
  onSelect,
}: {
  label: string;
  tooltip: string;
  /** Nothing usable was found, or what was chosen cannot be used. */
  warning: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      title={tooltip}
      className={cn(
        "hover:text-foreground flex cursor-pointer items-center gap-1 transition-colors",
        warning ? "text-warning" : "text-muted-foreground",
      )}
    >
      {label}
    </button>
  );
}
