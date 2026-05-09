import { Fragment, useMemo } from "react";

import { hashStringToBigInt, idToColor } from "@/lib/hash-color";
import { cn } from "@/lib/utils";

interface WorktreeIconProps {
  name: string;
  size: "xs" | "sm" | "md";
  active?: boolean;
}

const sizeClasses = { xs: "size-5", sm: "size-7", md: "size-7" };

/** Generate a symmetric 5x5 grid pattern from the lower 15 bits of a hash. */
function generatePattern5(hash: bigint): { x: number; y: number; show: boolean }[] {
  const left: { x: number; y: number; show: boolean }[] = [];
  for (let i = 0; i < 15; i++) {
    left.push({ show: Boolean(hash & (1n << BigInt(i))), x: Math.floor(i / 5), y: i % 5 });
  }
  // Mirror: columns 0,1,2 → 4,3 (column 2 is the center, shared)
  return [
    ...left,
    ...left.slice(5, 10).map(({ show, y }) => ({ x: 3, y, show })),
    ...left.slice(0, 5).map(({ show, y }) => ({ x: 4, y, show })),
  ];
}

export function WorktreeIcon({ name, size, active }: WorktreeIconProps) {
  const color = useMemo(() => idToColor(name), [name]);
  const pattern = useMemo(() => generatePattern5(hashStringToBigInt(name)), [name]);

  return (
    <svg
      viewBox="-1 -1 9 9"
      className={cn(
        "corner-superellipse shrink-0 rounded-2xl",
        sizeClasses[size],
        active && "shadow-[0_0_0_2px_white,0_0_0_4px_var(--primary)]",
      )}
      style={{ backgroundColor: color.bg }}
    >
      {pattern.map(({ show, x, y }, i) => (
        <Fragment key={i}>
          {show && (
            <rect
              x={x + 1}
              y={y + 1}
              width="1"
              height="1"
              rx="0.15"
              fill="white"
              fillOpacity="0.85"
            />
          )}
        </Fragment>
      ))}
    </svg>
  );
}
