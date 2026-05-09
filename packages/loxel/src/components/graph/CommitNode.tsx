import type { CommitInfo, RefInfo } from "@/api/git-models";

import { cn } from "@/lib/utils";

interface CommitNodeProps {
  commit: CommitInfo;
  x: number;
  y: number;
  color: string;
  selected: boolean;
  /** Total width of the graph column (graph lanes + ref labels area) */
  graphColumnWidth: number;
}

function RefLabel({ ref }: { ref: RefInfo }) {
  return (
    <span
      className={cn(
        "pointer-events-auto inline-block h-5 min-w-0 shrink overflow-hidden rounded px-1.5 text-[10px] leading-5 font-medium [text-overflow:ellipsis] whitespace-nowrap transition-all [direction:rtl] hover:z-10 hover:shrink-0 hover:overflow-visible",
        ref.type === "HEAD" && "bg-ref-head text-white",
        ref.type === "head" && "bg-ref-local/20 text-ref-local",
        ref.type === "remote" && "bg-ref-remote/20 text-ref-remote",
        ref.type === "tag" && "bg-ref-tag/20 text-ref-tag",
      )}
      title={ref.name}
    >
      {ref.name}
    </span>
  );
}

export function CommitNode({ commit, x, y, color, selected, graphColumnWidth }: CommitNodeProps) {
  const hasRefs = commit.refs.length > 0;
  const isUncommitted = !!commit.uncommitted;
  const refLabelOffset = 12;
  const refsAvailableWidth = Math.max(0, graphColumnWidth - x - refLabelOffset);

  return (
    <g>
      {/* Commit circle */}
      {isUncommitted ? (
        <>
          {/* Dashed hollow circle for uncommitted changes */}
          <circle
            cx={x}
            cy={y}
            r={5}
            fill="none"
            stroke={color}
            strokeWidth={2}
            strokeDasharray="3 2"
            className="transition-all"
          />
          {/* Selection ring */}
          {selected && (
            <circle
              cx={x}
              cy={y}
              r={8}
              fill="none"
              stroke="var(--foreground)"
              strokeWidth={1.5}
              className="transition-all"
            />
          )}
        </>
      ) : (
        <circle
          cx={x}
          cy={y}
          r={selected ? 6 : 5}
          fill={color}
          stroke={selected ? "var(--foreground)" : "none"}
          strokeWidth={2}
          className="transition-all"
        />
      )}

      {/* Ref labels — flex-shared space, hover expands to full name */}
      {hasRefs && (
        <foreignObject x={x + refLabelOffset} y={y - 10} width={refsAvailableWidth} height={20}>
          <div className="flex h-full items-center gap-1">
            {commit.refs.map((ref) => (
              <RefLabel key={ref.name} ref={ref} />
            ))}
          </div>
        </foreignObject>
      )}
    </g>
  );
}
