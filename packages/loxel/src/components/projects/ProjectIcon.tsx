import { useMemo } from "react";

import { idToColor } from "@/lib/hash-color";
import { cn } from "@/lib/utils";

interface ProjectIconProps {
  id: string;
  name: string;
  size: "xs" | "sm" | "md";
  active?: boolean;
}

const sizeClasses = {
  xs: "size-5 text-[9px] leading-none",
  sm: "size-7 text-xs",
  md: "size-8 text-sm",
};

export function ProjectIcon({ id, name, size, active }: ProjectIconProps) {
  const color = useMemo(() => idToColor(id), [id]);
  const letter = name.charAt(0).toUpperCase();

  return (
    <div
      className={cn(
        "corner-superellipse flex shrink-0 items-center justify-center rounded-2xl font-semibold select-none",
        sizeClasses[size],
        active && "shadow-[0_0_0_2px_white,0_0_0_4px_var(--primary)]",
      )}
      style={{ backgroundColor: color.bg, color: color.text }}
    >
      {letter}
    </div>
  );
}
