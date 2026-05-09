import { useVirtualizer } from "@tanstack/react-virtual";
import {
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  EraserIcon,
  FilterIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { stringify as yamlStringify } from "yaml";

import type { LogEntry, LogLevel } from "@/api/log-entry-model";

import { LOG_CATEGORIES } from "@/api/log-entry-model";
import { DraggablePanelHeader } from "@/components/panels/DraggablePanelHeader";
import { highlightCode } from "@/lib/highlighter";
import { cn } from "@/lib/utils";
import { useLogStore } from "@/store/logs";
import { useUIStore } from "@/store/ui";

const LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: "text-muted-foreground",
  info: "text-blue-400",
  warn: "text-amber-400",
  error: "text-red-400",
};

const MAX_CAT_LEN = Math.max(...LOG_CATEGORIES.map((c) => c.length));

const LEVEL_LABELS: Record<LogLevel, string> = {
  debug: "DBG",
  info: "INF",
  warn: "WRN",
  error: "ERR",
};

/** Strip trailing Z from ISO string for compact display. */
function formatTimestamp(iso: string): string {
  return iso.replace("Z", "");
}

function LogEntryRow({ entry }: { entry: LogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ctx = entry.ctx !== undefined && Object.keys(entry.ctx).length > 0 ? entry.ctx : null;

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
    };
  }, []);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(JSON.stringify(entry)).then(() => {
      setCopied(true);
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 1200);
    });
  }, [entry]);

  return (
    <div className="group hover:bg-muted/50 relative px-3 py-0.5 font-mono text-xs leading-5">
      <div className="whitespace-pre">
        {
          <button
            className={cn(
              "mr-0.5 inline-flex items-center align-baseline transition-transform select-none",
              ctx !== null ? "text-muted-foreground hover:text-foreground" : "invisible",
            )}
            onClick={ctx !== null ? () => setExpanded((v) => !v) : undefined}
          >
            <ChevronRightIcon
              className={cn("size-3 transition-transform", expanded && "rotate-90")}
            />
          </button>
        }
        <span className={cn("font-semibold", LEVEL_COLORS[entry.level])}>
          {LEVEL_LABELS[entry.level]}
        </span>{" "}
        <span className="text-muted-foreground">{`[${entry.cat.padEnd(MAX_CAT_LEN)}]`}</span>{" "}
        <span className="text-muted-foreground tabular-nums">{formatTimestamp(entry.ts)}</span>{" "}
        <span className="text-foreground">{entry.msg.replaceAll("\n", "\\n")}</span>
        {ctx !== null && !expanded && (
          <>
            {" "}
            <span className="text-muted-foreground">
              {Object.entries(ctx)
                .map(
                  ([k, v]) =>
                    `${k}=${typeof v === "string" ? v.replaceAll("\n", "\\n") : JSON.stringify(v)}`,
                )
                .join(" ")}
            </span>
          </>
        )}
      </div>
      {expanded && ctx !== null && <HighlightedYaml ctx={ctx} />}
      <button
        onClick={handleCopy}
        title={copied ? "Copied" : "Copy entry as JSON"}
        className="bg-muted/80 border-border text-muted-foreground hover:text-foreground absolute top-0.5 right-1 flex size-5 items-center justify-center rounded border opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100"
      >
        {copied ? <CheckIcon className="size-3 text-green-500" /> : <CopyIcon className="size-3" />}
      </button>
    </div>
  );
}

function HighlightedYaml({ ctx }: { ctx: Record<string, unknown> }) {
  const [html, setHtml] = useState<string | null>(null);
  const yaml = useMemo(() => yamlStringify(ctx, { lineWidth: 0 }).trimEnd(), [ctx]);

  useEffect(() => {
    let cancelled = false;
    highlightCode(yaml, "yaml", "github-dark")
      .then((lines) => {
        if (!cancelled) setHtml(lines.map((l) => l.html).join("\n"));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [yaml]);

  return (
    <pre
      className="mt-0.5 mb-1 ml-4 text-xs whitespace-pre-wrap"
      dangerouslySetInnerHTML={html !== null ? { __html: html } : undefined}
    >
      {html === null ? yaml : undefined}
    </pre>
  );
}

function FilterToggle({
  label,
  excluded,
  color,
  onClick,
}: {
  label: string;
  excluded: boolean;
  color?: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded px-1.5 py-0.5 text-xs transition-colors",
        excluded
          ? "text-muted-foreground/50 line-through"
          : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
      )}
    >
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          excluded ? "bg-muted" : (color ?? "bg-current"),
        )}
      />
      {label}
    </button>
  );
}

const LEVEL_DOT_COLORS: Record<LogLevel, string> = {
  debug: "bg-gray-400",
  info: "bg-blue-400",
  warn: "bg-amber-400",
  error: "bg-red-400",
};

function FilterSidebar() {
  const logExcludedLevels = useUIStore((s) => s.logExcludedLevels);
  const toggleLogLevel = useUIStore((s) => s.toggleLogLevel);
  const logExcludedCategories = useUIStore((s) => s.logExcludedCategories);
  const toggleLogCategory = useUIStore((s) => s.toggleLogCategory);

  return (
    <div className="border-border flex h-full w-32 shrink-0 flex-col gap-3 overflow-y-auto border-r px-2 py-2.5">
      <div>
        <div className="text-muted-foreground mb-1 text-[10px] font-semibold tracking-wider uppercase">
          Level
        </div>
        <div className="flex flex-col">
          {LEVELS.map((level) => (
            <FilterToggle
              key={level}
              label={level}
              excluded={logExcludedLevels.has(level)}
              color={LEVEL_DOT_COLORS[level]}
              onClick={() => toggleLogLevel(level)}
            />
          ))}
        </div>
      </div>

      <div>
        <div className="text-muted-foreground mb-1 text-[10px] font-semibold tracking-wider uppercase">
          Category
        </div>
        <div className="flex flex-col">
          {LOG_CATEGORIES.map((cat) => (
            <FilterToggle
              key={cat}
              label={cat}
              excluded={logExcludedCategories.has(cat)}
              onClick={() => toggleLogCategory(cat)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export function LogsPanel() {
  const entries = useLogStore((s) => s.entries);
  const hasMore = useLogStore((s) => s.hasMore);
  const initialized = useLogStore((s) => s.initialized);
  const loadingMore = useLogStore((s) => s.loadingMore);
  const initialize = useLogStore((s) => s.initialize);
  const fetchOlder = useLogStore((s) => s.fetchOlder);
  const clear = useLogStore((s) => s.clear);

  const logExcludedLevels = useUIStore((s) => s.logExcludedLevels);
  const logExcludedCategories = useUIStore((s) => s.logExcludedCategories);
  const sidebarOpen = useUIStore((s) => s.logFilterSidebarOpen);
  const setSidebarOpen = useUIStore((s) => s.setLogFilterSidebarOpen);
  const logTextFilter = useUIStore((s) => s.logTextFilter);
  const setLogTextFilter = useUIStore((s) => s.setLogTextFilter);
  // Defer the text filter so typing stays responsive even with live log bursts;
  // filtering runs against the deferred value while the input reflects the latest keystroke.
  const deferredTextFilter = useDeferredValue(logTextFilter);

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomSentinelRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const prevScrollHeightRef = useRef(0);
  const wasLoadingMoreRef = useRef(false);

  // Initialize on mount
  useEffect(() => {
    initialize();
  }, [initialize]);

  // Open the live log stream while the panel is mounted.
  // Ordered after `initialize()` so history loads before the WS stream opens
  // (dedup in the store tolerates overlap; this just matches the plan's ordering).
  useEffect(() => {
    useLogStore.getState().connectLive();
    return () => useLogStore.getState().disconnectLive();
  }, []);

  // Lowercase needle computed once per deferred-filter change, not per entry.
  const needle = useMemo(() => deferredTextFilter.trim().toLowerCase(), [deferredTextFilter]);

  // Filter entries by level, category, and free-text search.
  const filteredEntries = useMemo(
    () =>
      entries.filter((e) => {
        if (logExcludedLevels.size > 0 && logExcludedLevels.has(e.level)) return false;
        if (logExcludedCategories.size > 0 && logExcludedCategories.has(e.cat)) return false;
        if (needle.length > 0) {
          if (e.msg.toLowerCase().includes(needle)) return true;
          // Stringify ctx lazily so entries without ctx skip the cost.
          if (e.ctx !== undefined && JSON.stringify(e.ctx).toLowerCase().includes(needle))
            return true;
          return false;
        }
        return true;
      }),
    [entries, logExcludedLevels, logExcludedCategories, needle],
  );

  const hasActiveFilters =
    logExcludedLevels.size > 0 || logExcludedCategories.size > 0 || needle.length > 0;

  // Virtualized list — dynamic row heights via measureElement on the row wrapper.
  const virtualizer = useVirtualizer({
    count: filteredEntries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 20, // ~leading-5 row height; tuned by measureElement
    overscan: 20,
    getItemKey: (i) => filteredEntries[i]!.id,
  });

  const totalSize = virtualizer.getTotalSize();
  const virtualItems = virtualizer.getVirtualItems();

  // Stick-to-bottom: observe bottom sentinel
  useEffect(() => {
    const sentinel = bottomSentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry) isAtBottomRef.current = entry.isIntersecting;
      },
      { root: scrollRef.current, threshold: 0.1 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  // Auto-scroll to bottom when new entries arrive and user is at bottom
  useEffect(() => {
    if (isAtBottomRef.current && filteredEntries.length > 0) {
      virtualizer.scrollToIndex(filteredEntries.length - 1, { align: "end" });
    }
  }, [filteredEntries.length, virtualizer]);

  // Scroll-up history loading: observe top sentinel
  useEffect(() => {
    const sentinel = topSentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting && hasMore && !loadingMore) {
          // Snapshot the virtualizer's total size (= scrollHeight of the inner
          // sizer div) so we can adjust scrollTop after prepending history.
          prevScrollHeightRef.current = virtualizer.getTotalSize();
          fetchOlder();
        }
      },
      { root: scrollRef.current, threshold: 0.1 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loadingMore, fetchOlder, virtualizer]);

  // Restore scroll position after history prepend.
  // After older entries are appended to the front of `filteredEntries`, the
  // virtualizer's total size grows by the height of the new rows. We shift
  // scrollTop by that delta so the viewport stays on the entry the user was
  // looking at (rather than jumping to the new top).
  useLayoutEffect(() => {
    if (wasLoadingMoreRef.current && !loadingMore && scrollRef.current) {
      const newScrollHeight = virtualizer.getTotalSize();
      const delta = newScrollHeight - prevScrollHeightRef.current;
      if (delta > 0) {
        scrollRef.current.scrollTop += delta;
      }
    }
    wasLoadingMoreRef.current = loadingMore;
  }, [loadingMore, virtualizer]);

  const handleClear = useCallback(() => {
    clear();
    initialize();
  }, [clear, initialize]);

  const handleExport = useCallback(() => {
    if (filteredEntries.length === 0) return;
    const ndjson = filteredEntries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    const blob = new Blob([ndjson], { type: "application/x-ndjson" });
    const url = URL.createObjectURL(blob);
    // Local ISO timestamp with filename-safe separators.
    const now = new Date();
    const pad = (n: number) => n.toString().padStart(2, "0");
    const stamp =
      `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
      `T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    const a = document.createElement("a");
    a.href = url;
    a.download = `loxel-logs-${stamp}.ndjson`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [filteredEntries]);

  if (!initialized) {
    return (
      <div className="flex h-full flex-col">
        <DraggablePanelHeader panelId="logs">
          <span className="text-sm font-medium">Logs</span>
        </DraggablePanelHeader>
        <div className="text-muted-foreground flex flex-1 items-center justify-center text-sm">
          Loading...
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <DraggablePanelHeader panelId="logs" className="flex items-center gap-2">
        <span className="text-sm font-medium">Logs</span>
        <span className="text-muted-foreground text-xs">{filteredEntries.length}</span>

        <div className="flex-1" />

        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className={cn(
            "p-0.5 transition-colors",
            sidebarOpen || hasActiveFilters
              ? "text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
          title="Toggle filters"
        >
          <FilterIcon className={cn("size-3.5", hasActiveFilters && "fill-current")} />
        </button>

        <button
          onClick={handleExport}
          disabled={filteredEntries.length === 0}
          className={cn(
            "p-0.5 transition-colors",
            filteredEntries.length === 0
              ? "text-muted-foreground/40 cursor-not-allowed"
              : "text-muted-foreground hover:text-foreground",
          )}
          title="Export filtered logs as NDJSON"
        >
          <DownloadIcon className="size-3.5" />
        </button>

        <button
          onClick={handleClear}
          className="text-muted-foreground hover:text-foreground p-0.5 transition-colors"
          title="Clear logs"
        >
          <EraserIcon className="size-3.5" />
        </button>
      </DraggablePanelHeader>

      <div className="flex min-h-0 flex-1">
        {sidebarOpen && <FilterSidebar />}

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="border-border bg-editor-surface flex items-center border-b px-2 py-1">
            <div className="relative flex flex-1 items-center">
              <SearchIcon className="text-muted-foreground pointer-events-none absolute left-1.5 size-3" />
              <input
                type="text"
                aria-label="Filter logs by text"
                placeholder="Filter logs..."
                value={logTextFilter}
                onChange={(e) => setLogTextFilter(e.target.value)}
                className="bg-muted/50 text-foreground placeholder:text-muted-foreground w-full rounded py-0.5 pr-6 pl-6 font-mono text-xs focus:outline-none"
              />
              {logTextFilter.length > 0 && (
                <button
                  type="button"
                  onClick={() => setLogTextFilter("")}
                  aria-label="Clear log text filter"
                  title="Clear filter"
                  className="text-muted-foreground hover:text-foreground absolute right-1 p-0.5 transition-colors"
                >
                  <XIcon className="size-3" />
                </button>
              )}
            </div>
          </div>

          <div ref={scrollRef} className="bg-editor-surface min-w-0 flex-1 overflow-auto">
            <div ref={topSentinelRef} className="h-px" />

            {loadingMore && (
              <div className="text-muted-foreground py-1 text-center text-xs">
                Loading older logs...
              </div>
            )}

            {filteredEntries.length === 0 ? (
              <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
                No log entries
              </div>
            ) : (
              <div style={{ height: `${totalSize}px`, width: "100%", position: "relative" }}>
                {virtualItems.map((v) => {
                  const entry = filteredEntries[v.index];
                  if (!entry) return null;
                  return (
                    <div
                      key={v.key}
                      data-index={v.index}
                      ref={virtualizer.measureElement}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        transform: `translateY(${v.start}px)`,
                      }}
                    >
                      <LogEntryRow entry={entry} />
                    </div>
                  );
                })}
              </div>
            )}

            <div ref={bottomSentinelRef} className="h-px" />
          </div>
        </div>
      </div>
    </div>
  );
}
