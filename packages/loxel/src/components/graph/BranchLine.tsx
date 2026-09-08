import type { LayoutEdge } from "./layout";
import { generateEdgePath } from "./layout";

interface BranchLineProps {
  edge: LayoutEdge;
}

export function BranchLine({ edge }: BranchLineProps) {
  const path = generateEdgePath(edge);

  return (
    <path
      d={path}
      fill="none"
      stroke={edge.color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeDasharray={edge.dashed ? "4 3" : undefined}
      className={edge.isMerge ? "opacity-60" : ""}
    />
  );
}
