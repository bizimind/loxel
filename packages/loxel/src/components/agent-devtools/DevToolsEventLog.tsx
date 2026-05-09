import { EraserIcon, FilterIcon, PauseIcon, PlayIcon, SearchIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import { useAgentDevToolsStore } from "@/store/agent-devtools";

import { DevToolsEventRow } from "./DevToolsEventRow";

/** Collect all unique event types from the event list. */
function collectEventTypes(events: Array<{ event: { type: string } }>): string[] {
  const types = new Set<string>();
  for (const e of events) types.add(e.event.type);
  return Array.from(types).sort();
}

export function DevToolsEventLog({ sessionId }: { sessionId: string }) {
  const events = useAgentDevToolsStore((s) => s.sessions[sessionId]?.events ?? []);
  const typeFilter = useAgentDevToolsStore((s) => s.sessions[sessionId]?.typeFilter ?? new Set());
  const searchQuery = useAgentDevToolsStore((s) => s.sessions[sessionId]?.searchQuery ?? "");
  const isPaused = useAgentDevToolsStore((s) => s.sessions[sessionId]?.isPaused ?? false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [filterOpen, setFilterOpen] = useState(false);

  // Debounce the search query to avoid serializing all events per keystroke
  const [debouncedSearch, setDebouncedSearch] = useState(searchQuery);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchQuery), 150);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const seenTypes = useMemo(() => collectEventTypes(events), [events]);

  const filteredEvents = useMemo(() => {
    let result = events;
    if (typeFilter.size > 0) {
      result = result.filter((e) => typeFilter.has(e.event.type));
    }
    if (debouncedSearch) {
      const q = debouncedSearch.toLowerCase();
      result = result.filter((e) => JSON.stringify(e.event).toLowerCase().includes(q));
    }
    return result;
  }, [events, typeFilter, debouncedSearch]);

  const baseTime = events.length > 0 ? (events[0]?.receivedAt ?? Date.now()) : Date.now();

  // Track scroll position
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    setIsAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  }, []);

  // Auto-scroll when new events arrive and user is at bottom
  useEffect(() => {
    if (isAtBottom && !isPaused) {
      bottomRef.current?.scrollIntoView({ behavior: "instant" });
    }
  }, [filteredEvents.length, isAtBottom, isPaused]);

  const handleToggleType = useCallback(
    (type: string) => {
      const current = useAgentDevToolsStore.getState().sessions[sessionId]?.typeFilter ?? new Set();
      const next = new Set(current);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      useAgentDevToolsStore.getState().setTypeFilter(sessionId, next);
    },
    [sessionId],
  );

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="border-b-panel flex items-center gap-1 border-b px-2 py-1">
        <div className="relative flex flex-1 items-center">
          <SearchIcon className="text-muted-foreground absolute left-1.5 size-3" />
          <input
            type="text"
            placeholder="Filter events..."
            value={searchQuery}
            onChange={(e) =>
              useAgentDevToolsStore.getState().setSearchQuery(sessionId, e.target.value)
            }
            className="bg-muted/50 text-foreground placeholder:text-muted-foreground w-full rounded py-0.5 pr-2 pl-6 text-xs"
          />
        </div>

        <button
          onClick={() => setFilterOpen(!filterOpen)}
          className={cn(
            "text-muted-foreground hover:text-foreground rounded p-1 transition-colors",
            typeFilter.size > 0 && "text-blue-400",
          )}
          title="Type filter"
        >
          <FilterIcon className="size-3.5" />
        </button>
        <button
          onClick={() => useAgentDevToolsStore.getState().togglePause(sessionId)}
          className="text-muted-foreground hover:text-foreground rounded p-1 transition-colors"
          title={isPaused ? "Resume" : "Pause"}
        >
          {isPaused ? <PlayIcon className="size-3.5" /> : <PauseIcon className="size-3.5" />}
        </button>
        <button
          onClick={() => useAgentDevToolsStore.getState().clearEvents(sessionId)}
          className="text-muted-foreground hover:text-foreground rounded p-1 transition-colors"
          title="Clear"
        >
          <EraserIcon className="size-3.5" />
        </button>
        <span className="text-muted-foreground ml-1 text-[10px] tabular-nums">
          {filteredEvents.length}/{events.length}
        </span>
      </div>

      {/* Type filter dropdown */}
      {filterOpen && (
        <div className="border-b-panel flex flex-wrap gap-1 border-b px-2 py-1">
          {seenTypes.map((type) => (
            <button
              key={type}
              onClick={() => handleToggleType(type)}
              className={cn(
                "rounded px-1.5 py-0.5 text-[10px] transition-colors",
                typeFilter.has(type)
                  ? "bg-blue-500/20 text-blue-400"
                  : "text-muted-foreground hover:bg-muted/50",
              )}
            >
              {type}
            </button>
          ))}
          {typeFilter.size > 0 && (
            <button
              onClick={() => useAgentDevToolsStore.getState().setTypeFilter(sessionId, new Set())}
              className="text-muted-foreground hover:text-foreground text-[10px] underline"
            >
              clear
            </button>
          )}
        </div>
      )}

      {/* Paused indicator */}
      {isPaused && (
        <div className="border-b border-b-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-center text-[10px] text-amber-400">
          Paused
        </div>
      )}

      {/* Event list */}
      <div ref={scrollContainerRef} className="flex-1 overflow-auto" onScroll={handleScroll}>
        {filteredEvents.map((rawEvent) => (
          <DevToolsEventRow key={rawEvent.seq} rawEvent={rawEvent} baseTime={baseTime} />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
