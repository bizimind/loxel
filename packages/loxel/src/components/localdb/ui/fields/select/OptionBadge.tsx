import type { InlineOption } from "@bizimind/localdb-sdk";
import type React from "react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Derived from the option's own color (any CSS color): in light, a soft tint of it with a
 * matching border and deep text in the same hue; in dark, an outline in the color itself.
 */
const OPTION_COLOR_CLASSES = cn(
  "border-[color:oklch(from_var(--option-color)_0.82_min(c,0.1)_h)]",
  "bg-[color:oklch(from_var(--option-color)_0.96_min(c,0.035)_h)]",
  "text-[color:oklch(from_var(--option-color)_0.4_min(c,0.13)_h)]",
  "dark:text-foreground dark:border-[color:var(--option-color)] dark:bg-transparent",
);

/** A select option shown as a pill in its color. */
export function OptionBadge({ option }: { option: InlineOption }) {
  const style = option.color
    ? ({ "--option-color": option.color } as React.CSSProperties)
    : undefined;
  return (
    <Badge
      variant="outline"
      className={cn("h-6 px-2.5 py-0.5 text-[0.85em]", option.color && OPTION_COLOR_CLASSES)}
      style={style}
    >
      {option.label}
    </Badge>
  );
}
