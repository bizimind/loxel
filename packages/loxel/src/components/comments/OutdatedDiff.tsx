import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useState } from "react";

interface OutdatedDiffProps {
  originalContent: string[];
}

/**
 * Collapsible snippet showing the original code at the time a comment was created.
 * Used when a thread's anchor is "outdated" — the current code is already visible in the diff.
 */
export function OutdatedDiff({ originalContent }: OutdatedDiffProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border-border mt-2 overflow-hidden rounded border">
      <button
        className="hover:bg-muted/30 flex w-full items-center gap-1 px-2 py-1 text-[10px] text-amber-600 transition-colors dark:text-amber-400"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? (
          <ChevronDownIcon className="size-3 shrink-0" />
        ) : (
          <ChevronRightIcon className="size-3 shrink-0" />
        )}
        Original code at time of comment
      </button>

      {expanded && (
        <div className="border-border max-h-40 scrollbar-thin overflow-auto border-t font-mono text-[10px] leading-tight">
          {originalContent.map((line, i) => (
            <div key={i} className="text-muted-foreground px-2 py-px whitespace-pre">
              {line}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
