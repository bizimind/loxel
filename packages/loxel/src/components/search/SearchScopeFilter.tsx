import {
  CheckIcon,
  FilterIcon,
  FolderCodeIcon,
  FolderIcon,
  PlusIcon,
  StarIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { HighlightedLabel } from "@/components/ui/HighlightedLabel";
import { FileTypeIcon } from "@/lib/file-icons";
import { fuzzyMatch } from "@/lib/fuzzy-match";
import { cn } from "@/lib/utils";
import { useSearchStore } from "@/store/search";

import {
  SEARCH_PRESETS,
  scopeKey,
  type SearchScope,
  type SearchScopeCustom,
  type SearchScopeExtension,
  type SearchScopePackage,
} from "./search-scope-model";

interface OptionItem {
  scope: SearchScope;
  label: string;
  detail?: string;
  group: "preset" | "package" | "extension" | "recent" | "custom";
  score: number;
  matchIndices: number[];
}

export function SearchScopeFilter({
  searchInputRef,
}: {
  searchInputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const scopes = useSearchStore((s) => s.scopes);
  const scopeFilterOpen = useSearchStore((s) => s.scopeFilterOpen);
  const scopeFilterQuery = useSearchStore((s) => s.scopeFilterQuery);
  const availablePackages = useSearchStore((s) => s.availablePackages);
  const availableDirs = useSearchStore((s) => s.availableDirs) ?? [];
  const availableExtensions = useSearchStore((s) => s.availableExtensions) ?? [];
  const recentCustomPaths = useSearchStore((s) => s.recentCustomPaths);

  const anchorRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pendingFocusKey = useRef<string | null>(null);

  const selectedKeys = useMemo(() => {
    if (scopes.length === 0) return new Set(["preset:all"]);
    return new Set(scopes.map(scopeKey));
  }, [scopes]);
  const closePanel = useCallback(() => {
    useSearchStore.getState().setScopeFilterOpen(false);
    requestAnimationFrame(() => searchInputRef.current?.focus());
  }, [searchInputRef]);

  // Close panel on blur (when focus leaves both the panel and anchor)
  useEffect(() => {
    if (!scopeFilterOpen) return;
    const handleFocusIn = (e: FocusEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      closePanel();
    };
    document.addEventListener("focusin", handleFocusIn);
    return () => document.removeEventListener("focusin", handleFocusIn);
  }, [scopeFilterOpen, closePanel]);

  // Build filtered option list
  const options = useMemo(() => {
    const q = scopeFilterQuery.trim();
    const items: OptionItem[] = [];

    // Presets
    for (const preset of SEARCH_PRESETS) {
      const result = fuzzyMatch(q, preset.label);
      if (result) {
        items.push({
          scope: preset,
          label: preset.label,
          group: "preset",
          score: result.score,
          matchIndices: result.indices,
        });
      }
    }

    // Packages
    for (const pkg of availablePackages) {
      const matchPath = fuzzyMatch(q, pkg.relativePath);
      if (matchPath || !q) {
        const pkgScope: SearchScopePackage = {
          type: "package",
          name: pkg.name,
          relativePath: pkg.relativePath,
        };
        items.push({
          scope: pkgScope,
          label: pkg.relativePath,
          group: "package",
          score: matchPath?.score ?? 1,
          matchIndices: matchPath?.indices ?? [],
        });
      }
    }

    // Extensions (text-searchable only)
    for (const ext of availableExtensions) {
      const label = `*.${ext}`;
      const result = fuzzyMatch(q, label) ?? fuzzyMatch(q, ext);
      if (result || !q) {
        const extScope: SearchScopeExtension = { type: "extension", ext };
        items.push({
          scope: extScope,
          label,
          group: "extension",
          score: result?.score ?? 1,
          matchIndices: result?.indices ?? [],
        });
      }
    }

    // Recent custom paths
    for (const path of recentCustomPaths) {
      const result = fuzzyMatch(q, path);
      if (result) {
        const customScope: SearchScopeCustom = { type: "custom", relativePath: path };
        items.push({
          scope: customScope,
          label: path,
          group: "recent",
          score: result.score,
          matchIndices: result.indices,
        });
      }
    }

    // Directory autocomplete — only when user is typing, exclude already-shown packages
    if (q) {
      const packagePaths = new Set(availablePackages.map((p) => p.relativePath));
      const alreadyShown = new Set(items.map((it) => it.label));
      const MAX_DIR_MATCHES = 20;
      let count = 0;

      for (const dir of availableDirs) {
        if (count >= MAX_DIR_MATCHES) break;
        if (packagePaths.has(dir) || alreadyShown.has(dir)) continue;
        const result = fuzzyMatch(q, dir);
        if (result) {
          const customScope: SearchScopeCustom = { type: "custom", relativePath: dir };
          items.push({
            scope: customScope,
            label: dir,
            group: "custom",
            score: result.score,
            matchIndices: result.indices,
          });
          count++;
        }
      }
    }

    return items;
  }, [scopeFilterQuery, availablePackages, availableExtensions, availableDirs, recentCustomPaths]);

  // Group options for rendering
  const groupedOptions = useMemo(() => {
    const groups: Array<{ key: string; label: string; items: OptionItem[] }> = [];
    const byGroup = new Map<string, OptionItem[]>();

    for (const item of options) {
      const arr = byGroup.get(item.group) ?? [];
      arr.push(item);
      byGroup.set(item.group, arr);
    }

    const order: Array<{ key: string; label: string }> = [
      { key: "preset", label: "Presets" },
      { key: "package", label: "Packages" },
      { key: "extension", label: "Extensions" },
      { key: "recent", label: "Recent" },
      { key: "custom", label: "Directories" },
    ];

    for (const g of order) {
      const items = byGroup.get(g.key);
      if (items?.length) {
        groups.push({ key: g.key, label: g.label, items });
      }
    }

    return groups;
  }, [options]);

  // Restore focus to a previously focused option after filter query changes
  useEffect(() => {
    const key = pendingFocusKey.current;
    if (!key) return;
    pendingFocusKey.current = null;
    const el = listRef.current?.querySelector(`[data-scope-key="${key}"]`) as HTMLElement | null;
    if (el) {
      el.focus();
    } else {
      inputRef.current?.focus();
    }
  }, [groupedOptions]);

  // Focus input when opened
  useEffect(() => {
    if (scopeFilterOpen) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [scopeFilterOpen]);

  const toggleItem = useCallback((item: OptionItem) => {
    const store = useSearchStore.getState();
    store.toggleScope(item.scope);
    if (item.group === "custom" || item.group === "recent") {
      const path =
        item.scope.type === "custom" || item.scope.type === "package"
          ? item.scope.relativePath
          : "";
      if (path) store.addRecentCustomPath(path);
    }
  }, []);

  /** Move focus between option items and the filter input via arrow keys. */
  const handlePanelKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closePanel();
        return;
      }

      if (e.key === "Enter" || e.key === " ") {
        // If an option button is focused, let native click handle it.
        // If the input is focused, click the first visible option.
        const focused = document.activeElement;
        if (focused === inputRef.current) {
          e.preventDefault();
          e.stopPropagation();
          const first = listRef.current?.querySelector("[data-scope-option]") as HTMLElement | null;
          first?.click();
        } else {
          // Stop propagation so the dialog's Enter handler doesn't fire
          e.stopPropagation();
        }
        return;
      }

      // Forward typing to the filter input when an option button is focused
      if (document.activeElement !== inputRef.current) {
        const focusedKey = (document.activeElement as HTMLElement)?.dataset?.scopeKey;
        if (e.key === "Backspace") {
          e.preventDefault();
          e.stopPropagation();
          const store = useSearchStore.getState();
          store.setScopeFilterQuery(store.scopeFilterQuery.slice(0, -1));
          if (focusedKey) pendingFocusKey.current = focusedKey;
          return;
        }
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          e.stopPropagation();
          const store = useSearchStore.getState();
          store.setScopeFilterQuery(store.scopeFilterQuery + e.key);
          if (focusedKey) pendingFocusKey.current = focusedKey;
          return;
        }
      }

      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      e.stopPropagation();

      const items = listRef.current?.querySelectorAll("[data-scope-option]");
      if (!items?.length) return;

      const active = document.activeElement;
      const optionArray = Array.from(items) as HTMLElement[];
      const currentIdx = optionArray.indexOf(active as HTMLElement);

      if (e.key === "ArrowDown") {
        const next = currentIdx < 0 ? 0 : Math.min(currentIdx + 1, optionArray.length - 1);
        optionArray[next]?.focus();
        optionArray[next]?.scrollIntoView({ block: "nearest" });
      } else if (currentIdx <= 0) {
        inputRef.current?.focus();
      } else {
        optionArray[currentIdx - 1]?.focus();
        optionArray[currentIdx - 1]?.scrollIntoView({ block: "nearest" });
      }
    },
    [closePanel],
  );

  const scopeLabel = (scope: SearchScope): string => {
    switch (scope.type) {
      case "preset":
        return scope.label;
      case "package":
        return scope.relativePath;
      case "custom":
        return scope.relativePath;
      case "extension":
        return `*.${scope.ext}`;
      default: {
        const _exhaustive: never = scope;
        throw new Error(`Unknown SearchScope type: ${String(_exhaustive)}`);
      }
    }
  };

  const scopeIcon = (scope: SearchScope) => {
    switch (scope.type) {
      case "preset":
        return <StarIcon className="size-3 shrink-0" />;
      case "package":
        return <FolderCodeIcon className="size-3 shrink-0" />;
      case "custom":
        return <FolderIcon className="size-3 shrink-0" />;
      case "extension":
        return <FileTypeIcon filename={`file.${scope.ext}`} className="size-3 shrink-0" />;
      default: {
        const _exhaustive: never = scope;
        throw new Error(`Unknown SearchScope type: ${String(_exhaustive)}`);
      }
    }
  };

  return (
    <div className="relative">
      {/* Anchor row: clickable area to open dropdown */}
      <div
        ref={anchorRef}
        tabIndex={0}
        role="combobox"
        aria-expanded={scopeFilterOpen}
        className="border-border hover:bg-muted/50 focus:bg-muted/30 focus:ring-primary/50 flex min-h-8 cursor-pointer items-center gap-1.5 border-b px-3 py-1 transition-colors outline-none focus:ring-1 focus:ring-inset"
        onClick={() => {
          if (scopeFilterOpen) {
            closePanel();
          } else {
            const store = useSearchStore.getState();
            store.setScopeFilterQuery("");
            store.setScopeFilterOpen(true);
          }
        }}
        onKeyDown={(e) => {
          if (scopeFilterOpen) return;
          if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
            e.preventDefault();
            const store = useSearchStore.getState();
            store.setScopeFilterQuery("");
            store.setScopeFilterOpen(true);
          } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
            e.preventDefault();
            const store = useSearchStore.getState();
            store.setScopeFilterQuery(e.key);
            store.setScopeFilterOpen(true);
          }
        }}
      >
        <FilterIcon className="text-muted-foreground size-3.5 shrink-0" />

        {scopes.length === 0 && <span className="text-muted-foreground text-xs">All Files</span>}

        {scopes.map((scope) => (
          <button
            key={scopeKey(scope)}
            type="button"
            tabIndex={-1}
            className="bg-muted text-foreground focus:ring-primary/50 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] leading-4 focus:ring-1 focus:outline-none"
            onClick={(e) => {
              e.stopPropagation();
              useSearchStore.getState().removeScope(scope);
            }}
            onKeyDown={(e) => {
              if (e.key === "Backspace" || e.key === "Delete") {
                e.preventDefault();
                e.stopPropagation();
                useSearchStore.getState().removeScope(scope);
                searchInputRef.current?.focus();
              }
            }}
          >
            {scopeIcon(scope)}
            <span className="max-w-[120px] truncate">{scopeLabel(scope)}</span>
            <XIcon className="size-2.5 opacity-60" />
          </button>
        ))}

        <PlusIcon
          className={cn(
            "ml-auto size-3.5 shrink-0",
            scopeFilterOpen ? "text-foreground" : "text-muted-foreground",
          )}
        />
      </div>

      {/* Floating overlay panel */}
      {scopeFilterOpen && (
        <div
          ref={panelRef}
          className="bg-popover border-border absolute top-full right-1 left-1 z-50 mt-1 flex flex-col rounded-lg border shadow-[0_0px_0px_1px_rgba(255,255,255,.15),0_6px_16px_0px_rgba(0,0,0,.5)]"
          onKeyDown={handlePanelKeyDown}
        >
          {/* Filter input */}
          <div className="border-border border-b px-3 py-1.5">
            <input
              ref={inputRef}
              type="text"
              className="text-foreground placeholder:text-muted-foreground w-full bg-transparent text-xs outline-none"
              placeholder="Type to filter paths..."
              value={scopeFilterQuery}
              onChange={(e) => useSearchStore.getState().setScopeFilterQuery(e.target.value)}
            />
          </div>

          {/* Options list */}
          <div ref={listRef} className="max-h-[240px] overflow-y-auto py-1">
            {groupedOptions.map((group) => (
              <div key={group.key}>
                <div className="text-muted-foreground px-3 py-1 text-[10px] font-medium tracking-wider uppercase">
                  {group.label}
                </div>
                {group.items.map((item) => {
                  const key = scopeKey(item.scope);
                  const isSelected = selectedKeys.has(key);
                  return (
                    <button
                      key={key}
                      type="button"
                      data-scope-option
                      data-scope-key={key}
                      className={cn(
                        "flex w-full items-center gap-2 px-3 py-1 text-left text-xs transition-colors outline-none",
                        isSelected
                          ? "bg-primary text-foreground"
                          : "text-muted-foreground hover:bg-primary/50 focus:bg-primary",
                      )}
                      onClick={() => {
                        toggleItem(item);
                      }}
                    >
                      {scopeIcon(item.scope)}
                      <span className="min-w-0 flex-1 truncate">
                        <HighlightedLabel text={item.label} indices={item.matchIndices} />
                      </span>
                      {item.detail && (
                        <span className="text-muted-foreground truncate text-[11px]">
                          {item.detail}
                        </span>
                      )}
                      {isSelected && <CheckIcon className="text-primary size-3 shrink-0" />}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
