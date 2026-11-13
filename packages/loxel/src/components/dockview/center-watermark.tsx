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
import { useProjectStore } from "@/store/projects";
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

        {/* One grid for every row, so the fields line up after the longest label. */}
        <div className="grid w-[28rem] max-w-full grid-cols-[auto_minmax(0,1fr)_auto] gap-y-1">
          {panels.map((def) => (
            <QuickAction
              key={def.type}
              icon={<def.icon className="size-4" />}
              label={def.quickstartLabel}
              onClick={() => window.dispatchEvent(new CustomEvent(def.createEvent))}
              actionId={def.actionId ?? undefined}
              field={
                def.type === "terminal" ? (
                  <CommandField worktreePath={worktreePath} />
                ) : def.type === "browser" ? (
                  <AddressField />
                ) : undefined
              }
            />
          ))}
          {!worktreePath && <AddProjectAction />}
        </div>
      </div>
    </div>
  );
}

const ROW_CLASS =
  "text-muted-foreground col-span-3 grid grid-cols-subgrid items-center rounded-md text-sm transition-colors";

/**
 * A quickstart row: its label creates the panel. A `field` sits on the same line, between the
 * label and the shortcut, so every row keeps one line and the field reads as a hint until used.
 */
function QuickAction({
  icon,
  label,
  onClick,
  actionId,
  field,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  actionId?: ActionId;
  field?: React.ReactNode;
}) {
  const store = useKeybindingStore();
  const binding = actionId ? getBindingsForAction(store, actionId)[0] : undefined;
  const shortcut = binding && (
    <KeyBindingDisplay
      binding={binding}
      className="text-muted-foreground dark:text-muted-foreground/60 justify-self-end pr-3 pl-4 text-xs"
    />
  );
  const labelContent = (
    <span className="flex items-center gap-2.5">
      {icon}
      <span>{label}</span>
    </span>
  );

  if (!field) {
    return (
      <button
        onClick={onClick}
        className={cn(ROW_CLASS, "hover:text-foreground hover:bg-muted py-1.5 pl-3 text-left")}
      >
        {labelContent}
        <span />
        {shortcut ?? <span />}
      </button>
    );
  }

  return (
    <div className={cn(ROW_CLASS, "hover:bg-muted/60 focus-within:bg-muted")}>
      <button
        onClick={onClick}
        className="hover:text-foreground self-stretch rounded-l-md py-1.5 pr-4 pl-3 text-left transition-colors"
      >
        {labelContent}
      </button>
      <div className="relative min-w-0">{field}</div>
      {shortcut ?? <span />}
    </div>
  );
}

/**
 * Opens the Add Project dialog the sidebar hosts. Before the first project it is the page's main
 * action: a filled button the size of its label, set apart from the rows above it.
 */
function AddProjectAction() {
  const isFirstProject = useProjectStore((s) => s.projectsFetched && s.projects.length === 0);
  const open = () => dispatchLoxelEvent("loxel-open-add-project-wizard");
  const icon = <FolderPlusIcon className="size-4" />;
  if (!isFirstProject) return <QuickAction icon={icon} label="Add Project" onClick={open} />;
  return (
    <button
      onClick={open}
      className="bg-button-primary text-button-primary-foreground hover:bg-button-primary/85 col-span-3 mt-3 flex items-center gap-2.5 justify-self-start rounded-md py-1.5 pr-4 pl-3 text-sm transition-colors"
    >
      {icon}
      <span>Add Project</span>
    </button>
  );
}

/**
 * No box: the placeholder reads as a hint on the row, which shows the field's surface on hover and
 * focus. Never autofocused: keys belong to shortcuts.
 */
const FIELD_CLASS =
  "text-foreground placeholder:text-muted-foreground/45 w-full bg-transparent py-1.5 text-sm outline-none";

/** On the New Terminal row: Enter opens a terminal that runs the command, as `loxel terminal` does. */
function CommandField({ worktreePath }: { worktreePath: string | null }) {
  const [command, setCommand] = useState("");
  const homeDir = useProjectStore((s) => s.homeDir);

  const run = () => {
    const line = command.trim();
    // Home's terminals start in the home directory.
    const cwd = worktreePath ?? homeDir;
    if (!line || !cwd) return;
    setCommand("");
    // The server starts the shell with the command typed in, then this window opens its panel:
    // in the worktree, or in Home, since the home directory is in none.
    api
      .postOpenRequest({
        terminal: { cwd, command: line },
        ...(worktreePath ? { pinWtPath: worktreePath } : {}),
        windowId: WINDOW_ID,
      })
      .catch((err: unknown) => {
        uiLog.error("Failed to open a terminal", { error: err instanceof Error ? err : undefined });
        showToast(err instanceof Error ? err.message : "Failed to open a terminal");
      });
  };

  return (
    <>
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
    </>
  );
}

/**
 * On the New Browser row: Enter opens the typed address in a new browser panel, as its address bar
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
    <>
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
          className="bg-popover border-border absolute top-full -right-2 -left-2 z-10 mt-1.5 rounded-md border py-1 shadow-md"
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
    </>
  );
}
