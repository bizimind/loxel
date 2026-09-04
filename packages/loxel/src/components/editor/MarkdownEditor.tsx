import type { EditorView as ProseMirrorView } from "@milkdown/kit/prose/view";
import type { DockviewPanelApi } from "dockview-react";

/**
 * Core markdown editor component using milkdown/crepe.
 * Accepts a filePath and optional callbacks.
 * Persists content to disk via autosave with conflict detection.
 */
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { Crepe } from "@milkdown/crepe";
import {
  commandsCtx,
  editorViewCtx,
  parserCtx,
  remarkStringifyOptionsCtx,
} from "@milkdown/kit/core";
import {
  addBlockTypeCommand,
  clearTextInCurrentBlockCommand,
} from "@milkdown/kit/preset/commonmark";
import { Selection } from "@milkdown/kit/prose/state";
import { CheckIcon, ClipboardIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ConflictBanner } from "@/components/editor/ConflictBanner";
import { FrontmatterEditor } from "@/components/editor/FrontmatterEditor";
import { localDbDirectivePlugins } from "@/components/editor/localdb-directive/index.ts";
import { localDbBlockSchema } from "@/components/editor/localdb-directive/schema.ts";
import {
  type MergeCallbacks,
  AUTOSAVE_DEBOUNCE_MS,
  useDiskSyncedContent,
} from "@/hooks/use-disk-synced-content";
import { usePanelActivationFocus } from "@/hooks/usePanelActivationFocus";
import { frontendLog } from "@/lib/frontend-logger";
import { mergeFrontmatter, splitFrontmatter } from "@/lib/frontmatter";
import { dispatchOpenFile } from "@/lib/open-file";
import { rawLineToProsePosition } from "@/lib/prosemirror-position";
import { useEditorStateStore } from "@/store/editor-state";
import { useSettingsStore } from "@/store/settings-store";
import { useUIStore } from "@/store/ui";
import "@/styles/milkdown-theme.css";

/**
 * In-memory content cache keyed by absolute path (project root + filePath).
 * Secondary cache — disk is source of truth.
 * Preserves editor content across brief layout swap unmount/remount cycles.
 */
export const editorContentCache = new Map<string, string>();

/** Persists caret position across unmount/remount cycles (e.g. tab switches). */
const editorSelectionCache = new Map<string, number>();

/** Pre-seed the content cache so a new editor opens with the given markdown. */
export function setEditorContent(key: string, content: string): void {
  editorContentCache.set(key, content);
}

/** Migrate a cache entry when a file is moved (e.g., draft → project). */
export function renameEditorCacheKey(oldPath: string, newPath: string): void {
  const content = editorContentCache.get(oldPath);
  if (content !== undefined) {
    editorContentCache.set(newPath, content);
    editorContentCache.delete(oldPath);
  }
  const sel = editorSelectionCache.get(oldPath);
  if (sel !== undefined) {
    editorSelectionCache.set(newPath, sel);
    editorSelectionCache.delete(oldPath);
  }
}

const identity = (s: string) => s;

/**
 * Collapse trailing whitespace to a single `\n`.
 * Milkdown's trailing plugin appends an empty paragraph after block nodes
 * (lists, code blocks, etc.), which serializes as an extra `\n`.
 */
function normalizeTrailingNewline(s: string): string {
  return s.replace(/\n+$/, "\n");
}

/** CodeMirror theme matching loxel's JetBrains dark palette. */
const codeTheme = EditorView.theme({}, { dark: true });

const codeHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: "#cf8e6d" },
  { tag: tags.operator, color: "#cf8e6d" },
  { tag: tags.name, color: "#bcbec4" },
  { tag: tags.variableName, color: "#bcbec4" },
  { tag: tags.propertyName, color: "#c77dbb" },
  { tag: tags.function(tags.variableName), color: "#56a8f5" },
  { tag: tags.function(tags.propertyName), color: "#56a8f5" },
  { tag: tags.definition(tags.variableName), color: "#bcbec4" },
  { tag: tags.typeName, color: "#2fbaa3" },
  { tag: tags.className, color: "#2fbaa3" },
  { tag: tags.string, color: "#6aab73" },
  { tag: tags.special(tags.string), color: "#6aab73" },
  { tag: tags.number, color: "#2aacb8" },
  { tag: tags.bool, color: "#cf8e6d" },
  { tag: tags.null, color: "#cf8e6d" },
  { tag: tags.comment, color: "#7a7e85", fontStyle: "italic" },
  { tag: tags.lineComment, color: "#7a7e85", fontStyle: "italic" },
  { tag: tags.blockComment, color: "#7a7e85", fontStyle: "italic" },
  { tag: tags.meta, color: "#bbb529" },
  { tag: tags.regexp, color: "#6aab73" },
  { tag: tags.tagName, color: "#e8bf6a" },
  { tag: tags.attributeName, color: "#bababa" },
  { tag: tags.attributeValue, color: "#6a8759" },
  { tag: tags.heading, color: "#bcbec4", fontWeight: "bold" },
  { tag: tags.link, color: "#56a8f5", textDecoration: "underline" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "bold" },
]);

/** Scroll the editor so the current cursor is roughly 1/3 from the top of the viewport. */
function scrollCursorNearTop(view: ProseMirrorView): void {
  const sel = view.state.selection;
  const coords = view.coordsAtPos(sel.from);
  const editorDom = view.dom.parentElement;
  if (!editorDom) return;
  const editorRect = editorDom.getBoundingClientRect();
  const targetY = editorRect.top + editorRect.height / 3;
  const delta = coords.top - targetY;
  if (Math.abs(delta) > 10) {
    editorDom.scrollBy({ top: delta, behavior: "instant" });
  }
}

interface MarkdownEditorProps {
  filePath: string;
  line?: number;
  column?: number;
  onClose?: () => void;
  onCreateNew?: () => void;
  panelApi: DockviewPanelApi;
}

export function MarkdownEditor({
  filePath,
  line,
  column,
  onClose,
  onCreateNew,
  panelApi,
}: MarkdownEditorProps) {
  const darkMode = useUIStore((s) => s.darkMode);
  const containerRef = useRef<HTMLDivElement>(null);
  const crepeRef = useRef<Crepe | null>(null);

  usePanelActivationFocus(
    panelApi,
    useCallback(() => {
      crepeRef.current?.editor.action((ctx) => ctx.get(editorViewCtx).focus());
    }, []),
  );
  const portalRootRef = useRef<HTMLDivElement | null>(null);
  const editorReadyRef = useRef(false);

  // Track initial line/col for mount-time navigation (consumed once).
  const initialLineRef = useRef(line);
  const initialColRef = useRef(column);
  const mountedRef = useRef(false);

  const onCloseRef = useRef(onClose);
  const onCreateNewRef = useRef(onCreateNew);
  onCloseRef.current = onClose;
  onCreateNewRef.current = onCreateNew;

  // Merge callbacks for 3-way auto-merge. Refs populated in the Crepe mount effect.
  // ProseMirror normalizes markdown on round-trip, so applyContent MUST set isProgrammaticRef
  // and re-arm autosave explicitly. Returns canonicalized content for baseContent.
  const mergeGetRef = useRef<(() => string | null) | null>(null);
  const mergeApplyRef = useRef<((s: string, programmatic: boolean) => string | null) | null>(null);
  const mergeCallbacks = useMemo<MergeCallbacks>(
    () => ({
      getContent: () => mergeGetRef.current?.() ?? null,
      applyContent: (s, p) => mergeApplyRef.current?.(s, p) ?? null,
    }),
    [],
  );

  // Timer for clearing the programmatic update flag after the debounce window.
  // milkdown's markdownUpdated listener is debounced by 200ms, so we clear the flag
  // 300ms after the last programmatic dispatch to ensure the listener sees it as true.
  const programmaticClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const {
    diskContent,
    editorFileState,
    cacheKey,
    isError,
    save,
    saveNow,
    handleAcceptDisk: hookAcceptDisk,
    handleKeepMine,
    handleChange,
    isProgrammaticRef,
    autosaveTimerRef,
    getSerializedContentRef,
    saveOptionsRef,
    autoSaveOptionsRef,
  } = useDiskSyncedContent<string>({
    filePath,
    deserialize: identity,
    contentCache: editorContentCache,
    mergeCallbacks,
  });

  // Keep save option refs in sync with formatting settings.
  const formattingSettings = useSettingsStore((s) => s.editor.formatting);
  saveOptionsRef.current = formattingSettings.enabled
    ? { format: true, formattingSettings }
    : undefined;
  autoSaveOptionsRef.current =
    formattingSettings.enabled && formattingSettings.formatOnAutoSave
      ? { format: true, formattingSettings }
      : undefined;

  // Frontmatter state — kept as React state so FrontmatterEditor re-renders on change.
  // The ref mirrors the state for synchronous reads inside Crepe callbacks.
  const [frontmatter, setFrontmatter] = useState<string | null>(null);
  const frontmatterRef = useRef<string | null>(null);

  // Set getSerializedContent — reads current markdown from crepe, merged with frontmatter.
  // normalizeTrailingNewline collapses trailing whitespace to a single \n because
  // milkdown's trailing plugin appends an empty paragraph after block nodes (lists,
  // code blocks, etc.) which serializes as an extra \n.
  getSerializedContentRef.current = () => {
    try {
      const body = crepeRef.current?.getMarkdown() ?? null;
      if (body === null) return null;
      return mergeFrontmatter(frontmatterRef.current, normalizeTrailingNewline(body));
    } catch {
      return null;
    }
  };

  // Crepe key for destroy+recreate on accept-disk-version
  const [crepeKey, setCrepeKey] = useState(0);

  // Conflict resolution: accept disk version — update frontmatter from accepted content
  const handleAcceptDisk = useCallback(() => {
    const accepted = hookAcceptDisk();
    if (accepted !== null) {
      const { frontmatter: acceptedFm } = splitFrontmatter(accepted);
      frontmatterRef.current = acceptedFm;
      setFrontmatter(acceptedFm);
    }
    setCrepeKey((k) => k + 1);
  }, [hookAcceptDisk]);

  // Initialize Crepe editor — re-runs when crepeKey or cacheKey changes
  useEffect(() => {
    if (!containerRef.current) return;
    if (diskContent === null) return; // waiting for data
    const effectDiskContent = diskContent; // narrowed: string, not null
    let cancelled = false;

    // Capture cache key in closure so cleanup saves under the correct scope's key,
    // even if the scope changes before this effect is cleaned up.
    const effectCacheKey = cacheKey;

    const initialContent = editorContentCache.get(effectCacheKey) ?? diskContent;
    const { frontmatter: initialFm, body: initialBody } = splitFrontmatter(initialContent);
    frontmatterRef.current = initialFm;
    setFrontmatter(initialFm);

    const crepe = new Crepe({
      root: containerRef.current,
      defaultValue: initialBody,
      features: { [Crepe.Feature.ImageBlock]: false, [Crepe.Feature.Latex]: false },
      featureConfigs: {
        [Crepe.Feature.Placeholder]: { text: "Start writing...", mode: "doc" },
        [Crepe.Feature.CodeMirror]: { theme: [codeTheme, syntaxHighlighting(codeHighlight)] },
        [Crepe.Feature.BlockEdit]: {
          buildMenu: (builder) => {
            const dataGroup = builder.addGroup("data", "Data");
            dataGroup.addItem("localdb-widget", {
              label: "Database Widget",
              icon: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M12 3C7.58 3 4 4.79 4 7s3.58 4 8 4 8-1.79 8-4-3.58-4-8-4zM4 9v3c0 2.21 3.58 4 8 4s8-1.79 8-4V9c0 2.21-3.58 4-8 4s-8-1.79-8-4zm0 5v3c0 2.21 3.58 4 8 4s8-1.79 8-4v-3c0 2.21-3.58 4-8 4s-8-1.79-8-4z"/></svg>`,
              onRun: (ctx) => {
                const commands = ctx.get(commandsCtx);
                commands.call(clearTextInCurrentBlockCommand.key);
                commands.call(addBlockTypeCommand.key, {
                  nodeType: localDbBlockSchema.node.type(ctx),
                  attrs: { table: "", view: "table", viewId: null },
                });
              },
            });
          },
        },
      },
    });

    // LocalDb directive plugin: :::localdb blocks rendered as inline widgets
    for (const plugin of localDbDirectivePlugins) {
      crepe.editor.use(plugin);
    }

    // Align remark-stringify output with oxfmt/Prettier markdown defaults.
    crepe.editor.config((ctx) => {
      ctx.set(remarkStringifyOptionsCtx, {
        ...ctx.get(remarkStringifyOptionsCtx),
        bullet: "-",
        rule: "-",
      });
    });

    // On every change: merge with frontmatter, update cache + trigger autosave
    crepe.on((crepeApi) => {
      crepeApi.markdownUpdated((_ctx, markdown) => {
        const merged = mergeFrontmatter(frontmatterRef.current, markdown);
        editorContentCache.set(effectCacheKey, merged);
        if (isProgrammaticRef.current) return;
        handleChange(merged);
      });
    });

    crepeRef.current = crepe;

    const portalledElements = new Set<HTMLElement>();
    let popoverObserver: MutationObserver | undefined;
    let portalRoot: HTMLDivElement | undefined;

    crepe
      .create()
      .then(() => {
        if (cancelled) return;

        const milkdownEl = crepe.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const { doc } = view.state;

          if (initialLineRef.current) {
            // Search-result navigation — takes priority over saved position
            const targetPos = rawLineToProsePosition(
              doc,
              initialLineRef.current,
              initialColRef.current ?? 1,
              effectDiskContent,
            );
            initialLineRef.current = undefined;
            initialColRef.current = undefined;
            if (targetPos !== null) {
              const pos = Math.min(targetPos, doc.content.size);
              view.dispatch(view.state.tr.setSelection(Selection.near(doc.resolve(pos))));
              // Defer scroll to after layout — position cursor ~1/3 from top of viewport.
              // Guard with `cancelled` so the rAF is a no-op if the effect cleaned up.
              requestAnimationFrame(() => {
                if (!cancelled) scrollCursorNearTop(view);
              });
            }
            view.focus();
          } else {
            const savedPos = editorSelectionCache.get(effectCacheKey);
            if (savedPos !== undefined) {
              // Returning editor — restore saved caret position
              editorSelectionCache.delete(effectCacheKey);
              const pos = Math.min(savedPos, doc.content.size);
              view.dispatch(view.state.tr.setSelection(Selection.near(doc.resolve(pos))));
            } else if (!editorContentCache.has(effectCacheKey)) {
              // New editor — place cursor at end
              const end = doc.content.size;
              view.dispatch(view.state.tr.setSelection(Selection.near(doc.resolve(end))));
              view.focus();
            }
          }

          mountedRef.current = true;
          return view.dom.parentElement;
        });

        editorReadyRef.current = true;

        // Set merge callbacks for 3-way auto-merge
        mergeGetRef.current = () => {
          try {
            const body = normalizeTrailingNewline(crepe.getMarkdown());
            return mergeFrontmatter(frontmatterRef.current, body);
          } catch {
            return null;
          }
        };
        mergeApplyRef.current = (merged, programmaticMerge) => {
          try {
            const { frontmatter: mergedFm, body: mergedBody } = splitFrontmatter(merged);
            isProgrammaticRef.current = true;
            if (programmaticClearTimerRef.current) clearTimeout(programmaticClearTimerRef.current);
            crepe.editor.action((ctx) => {
              const view = ctx.get(editorViewCtx);
              const parser = ctx.get(parserCtx);
              const savedAnchor = view.state.selection.anchor;
              const newDoc = parser(mergedBody);
              const { tr } = view.state;
              tr.replaceWith(0, view.state.doc.content.size, newDoc.content);
              view.dispatch(tr);
              const pos = Math.min(savedAnchor, view.state.doc.content.size);
              view.dispatch(
                view.state.tr.setSelection(Selection.near(view.state.doc.resolve(pos))),
              );
            });
            if (mergedFm !== frontmatterRef.current) {
              frontmatterRef.current = mergedFm;
              setFrontmatter(mergedFm);
            }
            // Clear flag after milkdown's debounced listener window
            programmaticClearTimerRef.current = setTimeout(() => {
              isProgrammaticRef.current = false;
            }, 300);
            const canonicalBody = normalizeTrailingNewline(crepe.getMarkdown());
            const canonicalized = mergeFrontmatter(frontmatterRef.current, canonicalBody);
            editorContentCache.set(effectCacheKey, canonicalized);
            if (!programmaticMerge) {
              if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
              autosaveTimerRef.current = setTimeout(() => save(), AUTOSAVE_DEBOUNCE_MS);
            }
            return canonicalized;
          } catch {
            isProgrammaticRef.current = false;
            return null;
          }
        };

        if (milkdownEl) {
          milkdownEl.classList.toggle("dark", useUIStore.getState().darkMode);
        }

        // Portal popover elements out of overflow:hidden containers
        if (milkdownEl) {
          const root = document.createElement("div");
          root.className = "milkdown";
          if (useUIStore.getState().darkMode) root.classList.add("dark");
          root.style.cssText =
            "position:fixed;top:0;left:0;width:0;height:0;overflow:visible;z-index:9999;pointer-events:none";
          document.body.appendChild(root);
          portalRoot = root;
          portalRootRef.current = root;

          const popoverClasses = [
            "milkdown-slash-menu",
            "milkdown-toolbar",
            "milkdown-link-preview",
            "milkdown-link-edit",
            "language-picker",
          ];

          const popoverSelector = popoverClasses.map((c) => `.${c}`).join(",");

          const isPopover = (el: Element): el is HTMLElement =>
            el instanceof HTMLElement && popoverClasses.some((c) => el.classList.contains(c));

          const portalElement = (el: HTMLElement) => {
            if (portalledElements.has(el)) return;
            el.style.pointerEvents = "auto";
            if (el.classList.contains("language-picker")) {
              const wrapper = document.createElement("div");
              wrapper.className = "milkdown-code-block";
              wrapper.style.cssText =
                "position:static;border:none;padding:0;margin:0;background:none";
              wrapper.appendChild(el);
              root.appendChild(wrapper);
            } else {
              root.appendChild(el);
            }
            portalledElements.add(el);
          };

          popoverObserver = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
              for (const node of mutation.addedNodes) {
                if (!(node instanceof Element)) continue;
                if (isPopover(node)) portalElement(node as HTMLElement);
                for (const el of node.querySelectorAll<HTMLElement>(popoverSelector)) {
                  portalElement(el);
                }
              }
            }
          });
          popoverObserver.observe(milkdownEl, { childList: true, subtree: true });

          for (const el of milkdownEl.querySelectorAll<HTMLElement>(popoverSelector)) {
            portalElement(el);
          }
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          frontendLog
            .child("ui")
            .error("Editor creation failed", { error: err instanceof Error ? err : undefined });
        }
      });

    return () => {
      cancelled = true;
      editorReadyRef.current = false;
      mergeGetRef.current = null;
      mergeApplyRef.current = null;
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
      try {
        // Save selection position for restoration on remount
        crepe.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          editorSelectionCache.set(effectCacheKey, view.state.selection.anchor);
        });
        const body = normalizeTrailingNewline(crepe.getMarkdown());
        editorContentCache.set(effectCacheKey, mergeFrontmatter(frontmatterRef.current, body));
      } catch {
        // Editor may already be partially destroyed
      }
      popoverObserver?.disconnect();
      portalRoot?.remove();
      crepe.destroy();
      crepeRef.current = null;
    };
    // Re-create when crepeKey changes (accept disk version), content first loads,
    // or cache key changes (project/worktree switch)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crepeKey, diskContent !== null, cacheKey]);

  // Navigate to line:column when props change (e.g. clicking a different search result for
  // the same file). Skips the initial render — mount-time navigation is handled above.
  useEffect(() => {
    if (!mountedRef.current || !line) return;
    const crepe = crepeRef.current;
    if (!crepe || !editorReadyRef.current) return;
    crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const rawContent = editorContentCache.get(cacheKey) ?? diskContent ?? "";
      const targetPos = rawLineToProsePosition(view.state.doc, line, column ?? 1, rawContent);
      if (targetPos !== null) {
        const { doc } = view.state;
        const pos = Math.min(targetPos, doc.content.size);
        view.dispatch(view.state.tr.setSelection(Selection.near(doc.resolve(pos))));
        scrollCursorNearTop(view);
        view.focus();
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [line, column]);

  // Sync external disk changes into the live editor when in clean state.
  // Dirty/saving/diverged states are handled by the conflict resolution flow.
  // Reads state live from the store (not the ref) because useEffect runs after paint,
  // and a keystroke between commit and effect can flip the state to "dirty" while the
  // render-time ref still reports "clean" — that would wipe the user's just-typed char.
  useEffect(() => {
    if (diskContent === null || !editorReadyRef.current) return;
    const crepe = crepeRef.current;
    if (!crepe) return;

    if (useEditorStateStore.getState().files.get(filePath)?.state !== "clean") return;

    const { frontmatter: diskFm, body: diskBody } = splitFrontmatter(diskContent);

    let currentBody: string;
    try {
      currentBody = normalizeTrailingNewline(crepe.getMarkdown());
    } catch {
      return;
    }

    // Update frontmatter state if it changed
    if (diskFm !== frontmatterRef.current) {
      frontmatterRef.current = diskFm;
      setFrontmatter(diskFm);
    }

    if (currentBody === diskBody) {
      // Body unchanged but frontmatter may have changed — update cache
      editorContentCache.set(cacheKey, diskContent);
      return;
    }

    isProgrammaticRef.current = true;
    if (programmaticClearTimerRef.current) clearTimeout(programmaticClearTimerRef.current);
    try {
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const parser = ctx.get(parserCtx);
        const savedAnchor = view.state.selection.anchor;
        const newDoc = parser(diskBody);
        const { tr } = view.state;
        tr.replaceWith(0, view.state.doc.content.size, newDoc.content);
        view.dispatch(tr);
        const pos = Math.min(savedAnchor, view.state.doc.content.size);
        view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(pos))));
      });
      editorContentCache.set(cacheKey, diskContent);
    } catch {
      // Editor may have been destroyed between the ref check and the action
    }
    // Clear flag after milkdown's debounced markdownUpdated listener has fired (200ms)
    programmaticClearTimerRef.current = setTimeout(() => {
      isProgrammaticRef.current = false;
    }, 300);
  }, [diskContent, cacheKey, filePath]);

  // Keyboard shortcuts
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    function handleKeyDown(e: KeyboardEvent) {
      // Cmd+N and Cmd+W are handled by the global keybinding system (useKeybindings).
      if (e.metaKey && e.key === "s") {
        e.preventDefault();
        e.stopPropagation();
        saveNow();
      }
    }

    container.addEventListener("keydown", handleKeyDown, true);
    return () => container.removeEventListener("keydown", handleKeyDown, true);
  }, [save, crepeKey]);

  // Open relative file links in the appropriate editor instead of navigating.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    function handleClick(e: MouseEvent) {
      const link = (e.target as HTMLElement).closest?.("a[href]");
      if (!link) return;

      const href = link.getAttribute("href");
      if (!href) return;

      // Skip absolute URLs, anchors, and protocol links — only intercept relative file paths.
      if (/^(?:[a-z][a-z\d+.-]*:|#)/i.test(href)) return;

      e.preventDefault();
      e.stopPropagation();

      const dir = filePath.substring(0, filePath.lastIndexOf("/"));
      const resolved = new URL(href, `file://${dir}/`).pathname;
      dispatchOpenFile(resolved);
    }

    container.addEventListener("click", handleClick, true);
    return () => container.removeEventListener("click", handleClick, true);
  }, [filePath, crepeKey]);

  // Toggle dark mode class
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    for (const el of container.querySelectorAll(".milkdown")) {
      el.classList.toggle("dark", darkMode);
    }
    portalRootRef.current?.classList.toggle("dark", darkMode);
  }, [darkMode]);

  // Frontmatter change handler — merge with current body and propagate
  const handleFrontmatterChange = useCallback(
    (yaml: string | null) => {
      const rawBody = crepeRef.current?.getMarkdown();
      if (rawBody === undefined) return; // editor not yet ready — skip to avoid persisting empty body
      const body = normalizeTrailingNewline(rawBody);
      frontmatterRef.current = yaml;
      setFrontmatter(yaml);
      const merged = mergeFrontmatter(yaml, body);
      editorContentCache.set(cacheKey, merged);
      handleChange(merged);
    },
    [cacheKey, handleChange],
  );

  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout>>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  const handleCopy = useCallback(() => {
    const cached = editorContentCache.get(cacheKey);
    if (!cached) return;
    navigator.clipboard.writeText(cached).then(() => {
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 1500);
    });
  }, [cacheKey]);

  if (isError) {
    return (
      <div
        className="text-muted-foreground flex h-full items-center justify-center text-sm"
        style={{ backgroundColor: "var(--editor-surface)" }}
      >
        File not found
      </div>
    );
  }

  return (
    <div
      className="group/editor relative flex h-full w-full flex-col overflow-hidden"
      style={{ backgroundColor: "var(--editor-surface)" }}
    >
      {editorFileState === "diverged" && (
        <ConflictBanner onAcceptDisk={handleAcceptDisk} onKeepMine={handleKeepMine} />
      )}
      <FrontmatterEditor
        filePath={filePath}
        value={frontmatter}
        onChange={handleFrontmatterChange}
        isProgrammaticRef={isProgrammaticRef}
      />
      <div ref={containerRef} key={crepeKey} className="flex-1 overflow-hidden" />
      <button
        onClick={handleCopy}
        title="Copy markdown"
        className="bg-muted/80 border-border text-muted-foreground hover:text-foreground hover:bg-muted absolute top-3 right-3 flex size-7 items-center justify-center rounded-md border opacity-0 backdrop-blur-sm transition-opacity group-hover/editor:opacity-100"
      >
        {copied ? (
          <CheckIcon className="size-3.5 text-green-500" />
        ) : (
          <ClipboardIcon className="size-3.5" />
        )}
      </button>
    </div>
  );
}
