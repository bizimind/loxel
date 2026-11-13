/**
 * The quickstart page an empty editor area shows: a row per panel to create, with fields that run
 * a command in a new terminal or open a page in a new browser panel. Home, the layout shown with
 * no worktree active, lists only what needs no worktree, and offers to add a project (the dialog is
 * the sidebar's, which outlives this page).
 */
import type { IWatermarkPanelProps } from "dockview-react";
import { FolderPlusIcon } from "lucide-react";
import { useId, useMemo, useState } from "react";

import * as api from "@/api/client";
import { hostOf } from "@/components/browser/BrowserBookmarks";
import { Favicon } from "@/components/browser/Favicon";
import { addressBarUrl } from "@/components/browser/web-search";
import { KeyBindingDisplay } from "@/components/ui/key-binding-display";
import { showToast } from "@/components/ui/toast";
import { frontendLog } from "@/lib/frontend-logger";
import { dispatchLoxelEvent } from "@/lib/loxel-events";
import { cn } from "@/lib/utils";
import { WINDOW_ID } from "@/lib/window-id";
import { matchBookmarks, useBrowserBookmarksStore } from "@/store/browser-bookmarks";
import type { ActionId } from "@/store/keybindings/action-registry";
import { getBindingsForAction, useKeybindingStore } from "@/store/keybindings/keybinding-store";
import { QUICKSTART_PANELS } from "@/store/panel-config";
import { useWorktreeStore } from "@/store/worktrees";

const uiLog = frontendLog.child("ui");

/** Most bookmarks suggested under the address field. */
const MAX_SUGGESTIONS = 6;

/** Center watermark — visible when no center panels are open. */
export function CenterWatermark(_props: IWatermarkPanelProps) {
  const worktreePath = useWorktreeStore((s) => s.activeWorktreePath);
  const panels = worktreePath
    ? QUICKSTART_PANELS
    : QUICKSTART_PANELS.filter((def) => !def.needsWorktree);

  return (
    // Centered while it fits, scrolled from its top in a short editor area.
    <div className="bg-editor-surface h-full overflow-y-auto">
      <div className="flex min-h-full items-center justify-center gap-10 py-6">
        <img
          src="/watermark.svg"
          alt=""
          className="h-20 w-20 opacity-85 invert select-none dark:opacity-100 dark:invert-0"
          draggable={false}
        />

        <div className="flex w-72 flex-col gap-1.5">
          {panels.map((def) => (
            <div key={def.type} className="flex flex-col">
              <QuickAction
                icon={<def.icon className="size-4" />}
                label={def.quickstartLabel}
                onClick={() => window.dispatchEvent(new CustomEvent(def.createEvent))}
                actionId={def.actionId ?? undefined}
              />
              {def.type === "terminal" && worktreePath && (
                <CommandField worktreePath={worktreePath} />
              )}
              {def.type === "browser" && <AddressField />}
            </div>
          ))}
          {!worktreePath && <AddProjectAction />}
        </div>
      </div>
    </div>
  );
}

function QuickAction({
  icon,
  label,
  onClick,
  actionId,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  actionId?: ActionId;
}) {
  const store = useKeybindingStore();
  const binding = actionId ? getBindingsForAction(store, actionId)[0] : undefined;

  return (
    <button
      onClick={onClick}
      className="text-muted-foreground hover:text-foreground hover:bg-muted flex items-center gap-2.5 rounded-md px-3 py-1.5 text-sm transition-colors"
    >
      {icon}
      <span className="flex-1 text-left">{label}</span>
      {binding && (
        <KeyBindingDisplay
          binding={binding}
          className="text-muted-foreground dark:text-muted-foreground/60 ml-4 text-xs"
        />
      )}
    </button>
  );
}

/** Opens the Add Project dialog the sidebar hosts. */
function AddProjectAction() {
  return (
    <QuickAction
      icon={<FolderPlusIcon className="size-4" />}
      label="Add Project"
      onClick={() => dispatchLoxelEvent("loxel-open-add-project-wizard")}
    />
  );
}

/** Lined up under its row's label, quiet until used. Never autofocused: keys belong to shortcuts. */
const FIELD_CLASS =
  "border-border/70 text-foreground placeholder:text-muted-foreground/70 focus:border-ring h-7 w-full rounded-md border bg-transparent px-2 text-xs transition-colors outline-none";

/** Under New Terminal: Enter opens a terminal that runs the command, as `loxel terminal` does. */
function CommandField({ worktreePath }: { worktreePath: string }) {
  const [command, setCommand] = useState("");

  const run = () => {
    const line = command.trim();
    if (!line) return;
    setCommand("");
    // The server starts the shell with the command typed in, then this window opens its panel.
    api
      .postOpenRequest({
        terminal: { cwd: worktreePath, command: line },
        pinWtPath: worktreePath,
        windowId: WINDOW_ID,
      })
      .catch((err: unknown) => {
        uiLog.error("Failed to open a terminal", { error: err instanceof Error ? err : undefined });
        showToast(err instanceof Error ? err.message : "Failed to open a terminal");
      });
  };

  return (
    <div className="pt-0.5 pr-3 pb-1 pl-[2.375rem]">
      <input
        type="text"
        value={command}
        onChange={(e) => setCommand(e.target.value)}
        onKeyDown={(e) => {
          // Enter that commits an IME composition is not a submit.
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter") run();
          else if (e.key === "Escape") {
            setCommand("");
            e.currentTarget.blur();
          }
        }}
        placeholder="Run a command…"
        aria-label="Run a command in a new terminal"
        spellCheck={false}
        autoComplete="off"
        className={FIELD_CLASS}
      />
    </div>
  );
}

/**
 * Under New Browser: Enter opens the typed address in a new browser panel, as its address bar
 * would (text that is not an address is searched), or the bookmark picked from the suggestions.
 */
function AddressField() {
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  // The suggestion the arrow keys picked, or -1 for the typed text.
  const [picked, setPicked] = useState(-1);
  const bookmarks = useBrowserBookmarksStore((s) => s.bookmarks);
  const suggestions = useMemo(
    () => matchBookmarks(bookmarks, text, MAX_SUGGESTIONS),
    [bookmarks, text],
  );
  const listId = useId();
  const showSuggestions = focused && suggestions.length > 0;

  const open = (url: string) => {
    setText("");
    setPicked(-1);
    dispatchLoxelEvent("loxel-create-browser", { url });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (suggestions.length === 0) return;
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      // Cycles through the suggestions and back to the typed text.
      setPicked((p) => ((p + 1 + step + suggestions.length + 1) % (suggestions.length + 1)) - 1);
    } else if (e.key === "Enter") {
      const suggestion = suggestions[picked];
      if (suggestion) open(suggestion.url);
      else if (text.trim()) open(addressBarUrl(text));
    } else if (e.key === "Escape") {
      if (picked >= 0) {
        e.preventDefault();
        setPicked(-1);
        return;
      }
      setText("");
      e.currentTarget.blur();
    }
  };

  return (
    <div className="relative pt-0.5 pr-3 pb-1 pl-[2.375rem]">
      <input
        type="text"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setPicked(-1);
        }}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          setPicked(-1);
        }}
        placeholder="Open a URL or search…"
        aria-label="Open a URL or search in a new browser panel"
        role="combobox"
        aria-expanded={showSuggestions}
        aria-controls={showSuggestions ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={picked >= 0 ? `${listId}-${picked}` : undefined}
        spellCheck={false}
        autoComplete="off"
        className={FIELD_CLASS}
      />
      {showSuggestions && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Bookmarks"
          className="bg-popover border-border absolute inset-x-0 top-full z-10 mr-3 ml-[2.375rem] rounded-md border py-1 shadow-md"
        >
          {suggestions.map((bookmark, index) => (
            <li
              key={bookmark.url}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === picked}
              title={bookmark.url}
              // Before the field's blur hides the list.
              onMouseDown={(e) => {
                e.preventDefault();
                open(bookmark.url);
              }}
              onMouseEnter={() => setPicked(index)}
              className={cn(
                "flex cursor-pointer items-center gap-2 px-2 py-1 text-xs",
                index === picked && "bg-muted",
              )}
            >
              <Favicon url={bookmark.faviconUrl} />
              <span className="text-foreground min-w-0 truncate">
                {bookmark.title || bookmark.url}
              </span>
              <span className="text-muted-foreground ml-auto shrink-0 truncate text-[11px]">
                {hostOf(bookmark.url)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
