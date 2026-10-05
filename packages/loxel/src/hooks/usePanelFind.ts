import type { RefObject } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { FindBarProps, FindMatches } from "@/components/ui/find-bar";
import { registerFindTarget } from "@/lib/find-targets";

/** The panel-specific search a find bar drives. */
export interface FindBackend {
  /**
   * Search for `query`. `newQuery` is true when the query changed (typing, reopening the bar),
   * false when stepping to the next/previous match of the same query.
   */
  find: (query: string, direction: "next" | "previous", newQuery: boolean) => void;
  /** Remove match highlights (the query was cleared). */
  clear: () => void;
  /** Remove match highlights and give focus back to the panel's content (the bar closed). */
  close: () => void;
}

interface PanelFind {
  /** Props for `<FindBar>`, or null while the bar is closed. */
  barProps: Omit<FindBarProps, "label"> | null;
  /** Report match counts from the backend's result events. */
  setMatches: (matches: FindMatches | null) => void;
}

/**
 * Find bar state for a panel, wired to the `find.*` actions (⌘F, ⌘G, ⇧⌘G) while focus is inside
 * `rootRef`. The query is kept when the bar closes, so ⌘F reopens it with the last search.
 */
export function usePanelFind(
  rootRef: RefObject<HTMLElement | null>,
  backend: FindBackend,
): PanelFind {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<FindMatches | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);

  // Read through refs so the registered handlers stay stable.
  const backendRef = useRef(backend);
  backendRef.current = backend;
  const queryRef = useRef(query);
  queryRef.current = query;
  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;

  const open = useCallback(() => {
    if (!isOpenRef.current && queryRef.current) {
      backendRef.current.find(queryRef.current, "next", true);
    }
    setIsOpen(true);
    setFocusRequest((n) => n + 1);
  }, []);

  const step = useCallback(
    (direction: "next" | "previous") => {
      if (!isOpenRef.current || !queryRef.current) {
        open();
        return;
      }
      backendRef.current.find(queryRef.current, direction, false);
    },
    [open],
  );

  const onQueryChange = useCallback((value: string) => {
    setQuery(value);
    if (value) {
      backendRef.current.find(value, "next", true);
    } else {
      backendRef.current.clear();
      setMatches(null);
    }
  }, []);

  const onClose = useCallback(() => {
    setIsOpen(false);
    setMatches(null);
    backendRef.current.close();
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    return registerFindTarget(root, {
      open,
      next: () => step("next"),
      previous: () => step("previous"),
    });
  }, [rootRef, open, step]);

  const barProps = useMemo(
    () =>
      isOpen
        ? {
            query,
            matches,
            focusRequest,
            onQueryChange,
            onNext: () => step("next"),
            onPrevious: () => step("previous"),
            onClose,
          }
        : null,
    [isOpen, query, matches, focusRequest, onQueryChange, step, onClose],
  );

  return { barProps, setMatches };
}
