import { useMemo } from "react";

import { idToColor } from "@/lib/hash-color";
import { cn } from "@/lib/utils";

interface ProjectIconProps {
  id: string;
  name: string;
  size: "xs" | "sm";
  active?: boolean;
}

const sizeClasses = {
  xs: "size-5 text-[9px] leading-none",
  /** The size of a worktree icon, so the project sits in the sidebar's worktree column. */
  sm: "size-6 text-[11px] leading-none",
};

export function ProjectIcon({ id, name, size, active }: ProjectIconProps) {
  const color = useMemo(() => idToColor(id), [id]);
  const letter = name.charAt(0).toUpperCase();

  return (
    <div
      className={cn(
        "corner-superellipse flex shrink-0 items-center justify-center rounded-2xl border-[1.5px] font-semibold select-none",
        sizeClasses[size],
        active && "shadow-[0_0_0_2px_white,0_0_0_4px_var(--primary)]",
      )}
      // An outline in the project color, so a project reads differently from the solid worktree
      // icons in the same column. Unmixed, the line keeps 3:1 contrast on the card in both themes.
      style={{
        borderColor: color.bg,
        color: `color-mix(in oklch, ${color.bg}, var(--foreground) 40%)`,
      }}
    >
      {letter}
    </div>
  );
}
