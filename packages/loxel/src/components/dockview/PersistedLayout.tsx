import type { DockviewApi, IDockviewReactProps, SerializedDockview } from "dockview-react";
import { DockviewReact } from "dockview-react";
import { useCallback, useEffect, useRef, useState } from "react";

import * as api from "@/api/client";
import { localConnection, localServerId } from "@/api/local-server";
import { STORAGE_PREFIX } from "@/lib/env";
import { layoutCanonicalKey, layoutSessionKey } from "@/lib/layout-key-schema";
import { IS_FIRST_WINDOW, WINDOW_ID } from "@/lib/window-id";
import {
  type LayoutKey,
  layoutServer,
  layoutStorageKey,
  layoutWorktree,
} from "@/store/active-worktree";
import { registerLayoutCache } from "@/store/worktree-cache";
import { isListedWorktree } from "@/store/worktrees";

import { dropUnregisteredPanels } from "./drop-unregistered-panels";
import { layoutSnapshot } from "./layout-snapshot";
import { LayoutServerContext } from "./panel-context";

interface PersistedLayout {
  version: number;
  data: SerializedDockview;
}

export interface PersistedLayoutProps extends Omit<IDockviewReactProps, "onReady"> {
  /** Storage scope — typically "outer" or "center". */
  storagePrefix: string;
  /**
   * The layout shown, a worktree's or Home's: changing it, the same path on another server
   * included, triggers a save→clear→restore swap. Stored on its server under `layoutStorageKey`.
   */
  layoutKey: LayoutKey;
  /** Bump to invalidate all saved layouts for this prefix. */
  layoutVersion: number;
  /** Populate dockview when no saved layout exists. */
  createDefaultLayout: (api: DockviewApi) => void;
  /** One-time setup after initial load — register event handlers, sync state. */
  onApiReady?: (api: DockviewApi) => void;
  /** Called after every restore/creation (initial + worktree switch). */
  onLayoutRestored?: (api: DockviewApi) => void;
  /** Called on each layout change (suppressed during swaps). */
  onLayoutChange?: (api: DockviewApi) => void;
  /** Custom clear logic — replaces the default `api.clear()` during layout swap. */
  performClear?: (api: DockviewApi) => void;
  /**
   * A swap was cut off before its restore: the layout unmounted (going Home mid-switch) or the key
   * changed again. Undo what `performClear` set up for the restore, which will not come.
   */
  onSwapAbandoned?: () => void;
  /** Expose the DockviewApi to the parent. */
  apiRef?: React.MutableRefObject<DockviewApi | null>;
  /** Expose swapping state — event handlers can check this to skip destructive actions. */
  swappingRef?: React.MutableRefObject<boolean>;
}

const DEBOUNCE_MS = 500;

// Storage keys are constructed via the shared `layout-key-schema` module so the
// server's promote/recovery code matches exactly. Server SQLite is already
// scoped per-environment (loxel vs loxel-dev state dirs), so STORAGE_PREFIX
// isn't needed in the key (it's still used below to scan legacy localStorage).
function sessionKey(prefix: string, key: LayoutKey): string {
  return layoutSessionKey(WINDOW_ID, prefix, layoutStorageKey(key));
}

function canonicalKey(prefix: string, key: LayoutKey): string {
  return layoutCanonicalKey(prefix, layoutStorageKey(key));
}

/**
 * Whether `key`'s layout is stored where this window's store API reaches: on the window's server,
 * the only one it reaches today. Another server's layout is neither read nor written, so the row
 * of the same path on the window's server is never taken for it; it starts from the default.
 */
function storedOnWindowServer(key: LayoutKey): boolean {
  return layoutServer(key) === localServerId();
}

function parseLayout(raw: string, version: number): SerializedDockview | null {
  try {
    const parsed = JSON.parse(raw) as PersistedLayout;
    if (parsed.version !== version) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

/**
 * One-shot migration of pre-server-storage localStorage layouts to canonical.
 * Old format: `${STORAGE_PREFIX}-layout:<oldWindowId>:<prefix>:<key>` (or without prefix).
 * Picks any matching legacy entry and copies its raw value to the canonical server slot.
 */
async function migrateLegacyLayout(
  prefix: string,
  key: LayoutKey,
  version: number,
): Promise<SerializedDockview | null> {
  const suffix = `:${prefix}:${layoutStorageKey(key)}`;
  const legacyKeys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k) continue;
    if (!k.startsWith(`${STORAGE_PREFIX}-layout:`)) continue;
    if (k.startsWith(`${STORAGE_PREFIX}-layout:session:`)) continue;
    if (k.startsWith(`${STORAGE_PREFIX}-layout:canonical:`)) continue;
    if (k.endsWith(suffix)) legacyKeys.push(k);
  }
  if (legacyKeys.length === 0) return null;

  let raw: string | null = null;
  for (const k of legacyKeys) {
    const v = localStorage.getItem(k);
    if (v) raw = v;
  }
  if (!raw) {
    for (const k of legacyKeys) localStorage.removeItem(k);
    return null;
  }

  try {
    await api.putStore(canonicalKey(prefix, key), raw);
    for (const k of legacyKeys) localStorage.removeItem(k);
  } catch {
    // Server unavailable; leave legacy entries in place to retry on next launch.
  }
  return parseLayout(raw, version);
}

/**
 * Resolve the layout to restore for a given (prefix, key) on this window.
 *
 * Lookup order:
 *   1. session for THIS windowId — survives renderer reloads (Cmd+R).
 *   2. canonical (last-closed-window state) — only consulted when this is the
 *      first/only loxel window alive; additional windows start with the default.
 *   3. legacy localStorage migration — one-time copy into canonical.
 *
 * Returns the raw layout to apply via `api.fromJSON`, or null if nothing applies.
 */
async function fetchLayout(
  prefix: string,
  key: LayoutKey,
  version: number,
): Promise<SerializedDockview | null> {
  if (!storedOnWindowServer(key)) return null;
  try {
    const sessionRaw = await api.getStore(sessionKey(prefix, key));
    if (sessionRaw) {
      const layout = parseLayout(sessionRaw, version);
      if (layout) return layout;
    }
  } catch {
    /* fall through */
  }

  if (!IS_FIRST_WINDOW) return null;

  try {
    const canonicalRaw = await api.getStore(canonicalKey(prefix, key));
    if (canonicalRaw) {
      const layout = parseLayout(canonicalRaw, version);
      if (layout) return layout;
    }
  } catch {
    /* fall through */
  }

  return migrateLegacyLayout(prefix, key, version);
}

/**
 * Module-level flag set by the OUTER PersistedLayout during its swap cycle.
 * The center dockview's onDidRemovePanel handler checks this to avoid
 * destroying terminal PTYs during worktree switches
 * (the outer clear unmounts CenterHost, which fires removal events).
 */
let outerSwapping = false;

/**
 * The layouts this window has shown, per storage prefix, shared by every layout of that prefix:
 * the editor area remounts on every worktree switch, and with its own cache it would fetch its
 * layout from the server each time before it could render. A cached layout is the one in the
 * window's session row, or a default not yet written: only this window writes its session rows,
 * and a worktree's rows deleted with it are dropped from the cache too (`purgeWorktreeCache`, and
 * `forgetIfRemoved` for a layout left after its worktree was removed).
 */
const sharedLayoutCaches = new Map<string, Map<LayoutKey, SerializedDockview>>();

function sharedLayoutCache(prefix: string): Map<LayoutKey, SerializedDockview> {
  let cache = sharedLayoutCaches.get(prefix);
  if (!cache) {
    cache = new Map();
    sharedLayoutCaches.set(prefix, cache);
    // Registered for the window's lifetime, like the cache itself, so its entries are purged with
    // their worktrees.
    registerLayoutCache(cache);
  }
  return cache;
}

/** Where a restored layout came from: the server, the window's cache, or the default. */
type LayoutSource = "server" | "cache" | "default";

/**
 * Drop a removed worktree's layout, which may have changed since its purge, so a worktree recreated
 * at its path starts fresh.
 */
function forgetIfRemoved(cache: Map<LayoutKey, SerializedDockview>, key: LayoutKey): void {
  const worktree = layoutWorktree(key);
  if (worktree && !isListedWorktree(worktree)) cache.delete(key);
}

export function isOuterSwapping(): boolean {
  return outerSwapping;
}

export function setOuterSwapping(value: boolean): void {
  outerSwapping = value;
}

export function PersistedLayoutComponent({
  storagePrefix,
  layoutKey,
  layoutVersion,
  createDefaultLayout,
  onApiReady,
  onLayoutRestored,
  onLayoutChange,
  performClear,
  onSwapAbandoned,
  apiRef: externalApiRef,
  swappingRef: externalSwappingRef,
  components,
  tabComponents,
  ...dockviewProps
}: PersistedLayoutProps) {
  const internalApiRef = useRef<DockviewApi | null>(null);
  const cacheRef = useRef(sharedLayoutCache(storagePrefix));
  // A layout already shown in this window renders at once, without waiting for the server.
  const initialLayoutRef = useRef<SerializedDockview | null>(
    cacheRef.current.get(layoutKey) ?? null,
  );
  const initialSourceRef = useRef<LayoutSource>(initialLayoutRef.current ? "cache" : "default");
  // Last serialized form we wrote (or settled on) for the active key — skips
  // no-op saves from synthetic onDidLayoutChange events fired during restore.
  const lastSavedRef = useRef<string>("");
  const swappingRef = useRef(false);
  const prevKeyRef = useRef(layoutKey);
  // The layout dockview holds, whose server its panels get: it changes once a swap clears the
  // outgoing layout, not on the render that brings the new key, so the outgoing panels never
  // render as the same paths on the incoming server.
  const [shownKey, setShownKey] = useState(layoutKey);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Pending writes waiting for the debounce to fire — keyed by full storage key
  // (a single map is fine because each PersistedLayoutComponent owns its own).
  const pendingPayloadRef = useRef<Map<string, string>>(new Map());
  const [hydrated, setHydrated] = useState(() => initialLayoutRef.current !== null);

  // Stable refs for callbacks to avoid stale closures
  const onLayoutRestoredRef = useRef(onLayoutRestored);
  onLayoutRestoredRef.current = onLayoutRestored;
  const onLayoutChangeRef = useRef(onLayoutChange);
  onLayoutChangeRef.current = onLayoutChange;
  const createDefaultRef = useRef(createDefaultLayout);
  createDefaultRef.current = createDefaultLayout;
  const performClearRef = useRef(performClear);
  performClearRef.current = performClear;
  const onSwapAbandonedRef = useRef(onSwapAbandoned);
  onSwapAbandonedRef.current = onSwapAbandoned;

  /** Drain pending writes via the normal API client (regular fetch). */
  const flushPendingSave = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (pendingPayloadRef.current.size === 0) return;
    const payloads = Array.from(pendingPayloadRef.current.entries());
    pendingPayloadRef.current.clear();
    for (const [fullKey, snapshot] of payloads) {
      api.putStore(fullKey, snapshot).catch(() => {
        // Server unreachable — orphan recovery on next boot promotes the most
        // recent persisted snapshot, so a single dropped write isn't fatal.
      });
    }
  }, []);

  /**
   * Drain pending writes during page unload. Uses fetch keepalive so the
   * request survives renderer teardown — a regular fetch can be cancelled when
   * the BrowserWindow is destroyed, dropping the user's most recent edit.
   * Body limit is 64KB per request, well above any realistic layout size.
   */
  const flushPendingSaveOnUnload = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (pendingPayloadRef.current.size === 0) return;
    for (const [fullKey, snapshot] of pendingPayloadRef.current) {
      try {
        // The window's own server, the one `storedOnWindowServer` lets layouts be written to.
        void fetch(localConnection().apiUrl(`/stores/${encodeURIComponent(fullKey)}`), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value: snapshot }),
          keepalive: true,
        });
      } catch {
        // ignore — orphan recovery picks up the most recent on next server boot
      }
    }
    pendingPayloadRef.current.clear();
  }, []);

  const queueSave = useCallback(
    (key: LayoutKey, snapshot: string) => {
      if (!storedOnWindowServer(key)) return;
      pendingPayloadRef.current.set(sessionKey(storagePrefix, key), snapshot);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        flushPendingSave();
      }, DEBOUNCE_MS);
    },
    [storagePrefix, flushPendingSave],
  );

  // pagehide is the most reliable "page is going away" signal in both browsers
  // and Electron renderers — fires for navigation, reload, and window close.
  useEffect(() => {
    const handler = () => flushPendingSaveOnUnload();
    window.addEventListener("pagehide", handler);
    return () => window.removeEventListener("pagehide", handler);
  }, [flushPendingSaveOnUnload]);

  // Unmounted with the page still up (going to or leaving Home): write the last change now, so the
  // layout mounted next for this key reads it rather than the one before. Leaving for Home because
  // the worktree was removed runs no swap, so its layout is forgotten here.
  useEffect(
    () => () => {
      flushPendingSave();
      forgetIfRemoved(cacheRef.current, prevKeyRef.current);
    },
    [flushPendingSave],
  );

  // Hydrate the initial layout before mounting DockviewReact so onReady can restore synchronously.
  useEffect(() => {
    if (initialLayoutRef.current) return;
    let cancelled = false;
    (async () => {
      const layout = await fetchLayout(storagePrefix, layoutKey, layoutVersion);
      if (cancelled) return;
      initialLayoutRef.current =
        layout && dropUnregisteredPanels(layout, { components, tabComponents });
      if (layout) initialSourceRef.current = "server";
      setHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
    // Initial fetch only — subsequent layoutKey changes are handled by the swap effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * After restoring or creating a layout, record the snapshot and (when appropriate)
   * persist it to this window's session. We persist whenever the layout came from
   * the server OR is the default of the first-and-only window — both cases mean the
   * window's "starting state" is meaningful and should survive promote-on-close.
   * Additional (non-first) windows that get a default layout don't persist until
   * the user actually modifies something, so they can't clobber canonical. A layout
   * from the window's cache is never written: it is already in the session row, or
   * is such a default.
   */
  const settleAfterRestore = useCallback(
    (dvApi: DockviewApi, key: LayoutKey, source: LayoutSource) => {
      const data = layoutSnapshot(dvApi);
      const snapshot = JSON.stringify({ version: layoutVersion, data });
      lastSavedRef.current = snapshot;
      cacheRef.current.set(key, data);
      const persist = source === "server" || (source === "default" && IS_FIRST_WINDOW);
      if (persist && storedOnWindowServer(key)) {
        flushPendingSave();
        api.putStore(sessionKey(storagePrefix, key), snapshot).catch(() => {});
      }
    },
    [layoutVersion, storagePrefix, flushPendingSave],
  );

  // Layout swap on layoutKey change (worktree/project switch)
  useEffect(() => {
    if (!hydrated) return;
    const dvApi = internalApiRef.current;
    if (!dvApi) return;

    const oldKey = prevKeyRef.current;
    const newKey = layoutKey;
    if (oldKey === newKey) return;

    prevKeyRef.current = newKey;

    // Save the old layout (in-memory cache + flush pending debounce + immediate write)
    if (dvApi.panels.length > 0) {
      const data = layoutSnapshot(dvApi);
      const snapshot = JSON.stringify({ version: layoutVersion, data });
      cacheRef.current.set(oldKey, data);
      flushPendingSave();
      // Skip writes when nothing changed since last settle/save. This protects an
      // additional (non-first) window that opened with the default layout for the
      // OLD worktree and never modified it — without this gate, the swap would
      // promote the unmodified default into canonical on close. If the old worktree
      // was removed, the server drops this write, so it cannot bring its rows back.
      if (snapshot !== lastSavedRef.current) {
        lastSavedRef.current = snapshot;
        if (storedOnWindowServer(oldKey)) {
          api.putStore(sessionKey(storagePrefix, oldKey), snapshot).catch(() => {});
        }
      }
    }

    // Leaving a worktree that was removed: a worktree later created there starts fresh.
    forgetIfRemoved(cacheRef.current, oldKey);

    // Begin swap
    swappingRef.current = true;
    if (externalSwappingRef) externalSwappingRef.current = true;

    if (performClearRef.current) {
      performClearRef.current(dvApi);
    } else {
      dvApi.clear();
    }
    setShownKey(newKey);

    let cancelled = false;
    let restored = false;
    (async () => {
      const cached = cacheRef.current.get(newKey);
      let source: LayoutSource = "default";
      if (cached) {
        dvApi.fromJSON(cached);
        source = "cache";
      } else {
        const fetched = await fetchLayout(storagePrefix, newKey, layoutVersion);
        if (cancelled) return;
        if (fetched) {
          dvApi.fromJSON(dropUnregisteredPanels(fetched, { components, tabComponents }));
          source = "server";
        } else {
          createDefaultRef.current(dvApi);
        }
      }

      onLayoutRestoredRef.current?.(dvApi);
      settleAfterRestore(dvApi, newKey, source);

      swappingRef.current = false;
      if (externalSwappingRef) externalSwappingRef.current = false;
      restored = true;
    })();

    return () => {
      cancelled = true;
      if (restored) return;
      swappingRef.current = false;
      if (externalSwappingRef) externalSwappingRef.current = false;
      onSwapAbandonedRef.current?.();
    };
  }, [
    hydrated,
    layoutKey,
    storagePrefix,
    layoutVersion,
    flushPendingSave,
    settleAfterRestore,
    externalSwappingRef,
    components,
    tabComponents,
  ]);

  const onReady = useCallback(
    (event: { api: DockviewApi }) => {
      const { api: dvApi } = event;
      internalApiRef.current = dvApi;
      if (externalApiRef) externalApiRef.current = dvApi;

      if (initialLayoutRef.current) {
        dvApi.fromJSON(initialLayoutRef.current);
      } else {
        createDefaultRef.current(dvApi);
      }

      onApiReady?.(dvApi);
      onLayoutRestoredRef.current?.(dvApi);
      settleAfterRestore(dvApi, layoutKey, initialSourceRef.current);

      dvApi.onDidLayoutChange(() => {
        if (swappingRef.current || outerSwapping) return;
        const data = layoutSnapshot(dvApi);
        const snapshot = JSON.stringify({ version: layoutVersion, data });
        if (snapshot === lastSavedRef.current) return;
        lastSavedRef.current = snapshot;
        cacheRef.current.set(prevKeyRef.current, data);
        queueSave(prevKeyRef.current, snapshot);
        onLayoutChangeRef.current?.(dvApi);
      });
    },
    // onApiReady is intentionally captured once — its event handlers shouldn't be re-registered.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [storagePrefix, layoutVersion, queueSave, settleAfterRestore],
  );

  if (!hydrated) return null;

  return (
    <LayoutServerContext.Provider value={layoutServer(shownKey)}>
      <DockviewReact
        {...dockviewProps}
        components={components}
        tabComponents={tabComponents}
        onReady={onReady}
      />
    </LayoutServerContext.Provider>
  );
}
