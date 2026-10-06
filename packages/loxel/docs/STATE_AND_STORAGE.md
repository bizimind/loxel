# State and storage

How the renderer holds state in zustand stores, which parts are persisted, how persistence flows through the Bun server into SQLite, and how secrets are protected at rest.

## Overview

The renderer owns UI state in zustand stores under [src/store/](../src/store/). Server data (Git, files, reviews) mostly lives in TanStack Query caches under [src/queries/](../src/queries/), kept fresh by WebSocket messages in [ws-bridge.ts](../src/queries/ws-bridge.ts); this doc covers the zustand side and the server's persistent files. Nothing the renderer persists stays in the browser: persisted stores write to the server's `stores.db` through `/api/stores/:key`, so every window (see [SHARED_SERVER.md](SHARED_SERVER.md)) reads the same values. The few deliberate exceptions are listed under [Browser storage](#browser-storage).

## Client stores by scope

### Global (one instance per window)

| Store                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Persisted key | What it holds                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| [settings-store.ts](../src/store/settings-store.ts)                                                                                                                                                                                                                                                                                                                                                                                                   | `settings`    | User settings; see [Settings](#settings)                                                                                           |
| [keybinding-store.ts](../src/store/keybindings/keybinding-store.ts)                                                                                                                                                                                                                                                                                                                                                                                   | `keybindings` | Template and overrides; see [KEYBINDINGS.md](KEYBINDINGS.md)                                                                       |
| [ui.ts](../src/store/ui.ts)                                                                                                                                                                                                                                                                                                                                                                                                                           | `ui`          | Theme, diff view mode, favorite branches, log filters                                                                              |
| [search.ts](../src/store/search.ts)                                                                                                                                                                                                                                                                                                                                                                                                                   | `search`      | Only `recentCustomPaths`; query and results are ephemeral                                                                          |
| [projects.ts](../src/store/projects.ts)                                                                                                                                                                                                                                                                                                                                                                                                               | `projects`    | Sidebar width/expansion, expanded project IDs; the project list itself is fetched from the server                                  |
| [worktrees.ts](../src/store/worktrees.ts)                                                                                                                                                                                                                                                                                                                                                                                                             | `worktrees`   | `byProject` (worktree lists per project path) and `activeWorktreePath`; only `customOrder`/`hiddenPaths` per project are persisted |
| [editor-state.ts](../src/store/editor-state.ts), [comments.ts](../src/store/comments.ts), [coding-agent.ts](../src/store/coding-agent.ts), [agent-devtools.ts](../src/store/agent-devtools.ts), [logs.ts](../src/store/logs.ts), [panel-badges.ts](../src/store/panel-badges.ts), [panel-notifications.ts](../src/store/panel-notifications.ts), [file-search.ts](../src/store/file-search.ts), [command-palette.ts](../src/store/command-palette.ts) | none          | Ephemeral runtime state                                                                                                            |

Some global stores are keyed internally by worktree or session rather than using the per-worktree factory: `file-search.ts` keeps `Map`s keyed by worktree, `coding-agent.ts` and `agent-devtools.ts` keep `Record`s keyed by session ID. `panel-notifications.ts` mirrors server state (the server's in-memory `NotificationStore`) and is not a source of truth. `comments.ts` is cleared on every worktree switch by `transitionWorktreeState` in [worktree-cache.ts](../src/store/worktree-cache.ts).

### Per-worktree

[worktree-store.ts](../src/store/worktree-store.ts) provides `createWorktreeStore(stateCreator)`, which keeps one vanilla zustand store per worktree path and returns `{ useStore, getStore, getCurrent, purge }`:

- `useStore(selector)` subscribes to the instance for `useWorktreeStore.activeWorktreePath`, so a worktree switch re-renders components against the new instance.
- `getCurrent()` resolves the module-level `activeWorktreeKey` for imperative code (actions, event handlers). `switchWorktree` in [worktrees.ts](../src/store/worktrees.ts) sets it synchronously through `transitionWorktreeState` before React re-renders, so imperative and hook access agree.
- With no active worktree, both return a shared no-op instance that logs a warning on `setState`.
- Every factory registers itself; `purgeWorktreeStores(path)` drops that worktree's instance from all of them. [worktrees.ts](../src/store/worktrees.ts) calls it, together with `purgeWorktreeCache`, when a worktree is removed or disappears from its project.

Stores built on the factory, all in memory only:

| Store                                                         | Holds                                                                                                         |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [worktree-ui.ts](../src/store/worktree-ui.ts)                 | Graph search and filters, selected diff/project file, expanded folders, pending reveal and pending file opens |
| [worktree-tools-bar.ts](../src/store/worktree-tools-bar.ts)   | Tool bar entries per zone, active sidebar panels, terminal instances, last sidebar sizes                      |
| [worktree-repository.ts](../src/store/worktree-repository.ts) | Selected commits and diff source                                                                              |
| [worktree-reviews.ts](../src/store/worktree-reviews.ts)       | Review list and selection for the review overlay (see [CODE_REVIEW.md](CODE_REVIEW.md))                       |

Related helpers that are not stores:

- [worktree-cache.ts](../src/store/worktree-cache.ts): a `Map` keyed by `${worktreePath}::${key}` for component-local values that must survive a worktree switch, used for inner dockview layouts (`getWorktreeInnerLayout`). Not persisted.
- [worktree-history.ts](../src/store/worktree-history.ts): back/forward stacks of worktree paths, in memory per window, fed by a subscription to `activeWorktreePath`.
- [active-worktree.ts](../src/store/active-worktree.ts): `getActiveWt()` reads the active path or throws; used by actions that require a worktree.

Per-worktree state survives switching within a window's lifetime but not a reload. What does survive a reload per worktree is the dockview layout (see [Layout persistence](#layout-persistence)) and the server-side state described in [SHARED_SERVER.md](SHARED_SERVER.md#state-scopes).

### Adding a store

- Ephemeral global state: `create<State>()((set, get) => ...)` in a domain-named file under `src/store/`.
- State that differs per worktree: use `createWorktreeStore` rather than a `Record` keyed by path, so purge on removal and the active-worktree binding come for free.
- Persisted state: see [Adding a persisted field](#adding-a-persisted-field).

## Persistence path

### Client: `createServerStorage`

[server-storage.ts](../src/store/server-storage.ts) implements zustand's `StateStorage` on top of `GET/PUT /api/stores/:key` ([client.ts](../src/api/client.ts) `getStore`/`putStore`). Persisted stores use `persist(..., { storage: createJSONStorage(() => serverXStorage), partialize, ... })`, with one prebuilt storage instance per store key exported from `server-storage.ts`.

- **Key.** The server row key is the argument to `createServerStorage` (`settings`, `ui`, ...). The persist `name` (`${STORAGE_PREFIX}-settings`, where `STORAGE_PREFIX` is `loxel` or `loxel-dev`) is only used to find legacy localStorage data. Server keys need no environment prefix because dev and prod state directories are separate.
- **Value.** The raw string zustand persist produces: `{"state": <partialized state>, "version": n}`.
- **Hydration.** `getItem` is async, so stores hydrate after the first render. Code that needs persisted values at startup waits for `persist.hasHydrated()` / `persist.onFinishHydration` (for example [schema-sync.ts](../src/lib/schema-sync.ts)).
- **Legacy migration.** If the server has no row (or is unreachable), `getItem` falls back to `localStorage[name]`, uploads it, and removes the local copy only after the upload succeeds.
- **Writes.** `setItem` is debounced per store (500 ms, last value wins) and tagged with a random nonce. Failures are swallowed: in-memory state is the source of truth and the next change retries. Pending store writes are not flushed on page unload.
- **Deletes.** `removeItem` is a no-op; rows are never deleted through persist.

### Server: `/api/stores/:key` and `stores.db`

The route in [routes.ts](../src/server/routes.ts) reads or upserts the row through [store-db.ts](../src/server/store-db.ts). After a PUT whose value parses to an object with a `state` field, it broadcasts `{ type: "store_updated", key, state, nonce }` to every app client ([ws-protocol.ts](../src/api/ws-protocol.ts)). Values without `state` (layouts, server-owned keys) are stored without a broadcast.

`stores.db` is a single table `stores(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)`, opened lazily in WAL mode with a 5-second busy timeout. Key namespaces in use:

| Key                                                                | Writer                                                                                                                 |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `settings`, `keybindings`, `ui`, `search`, `worktrees`, `projects` | Renderer, via `createServerStorage`                                                                                    |
| `layout:session:<windowId>:<scope>:<worktreePath>`                 | Renderer, via `PersistedLayout`                                                                                        |
| `layout:canonical:<scope>:<worktreePath>`                          | Server (promotion), renderer (legacy layout migration)                                                                 |
| `external-folders:<worktreePath>`                                  | Server, [external-folders-service.ts](../src/server/external-folders-service.ts); deleted when the worktree is removed |

### Multi-window propagation

[ws-bridge.ts](../src/queries/ws-bridge.ts) handles `store_updated`: if `consumeNonce(nonce)` reports that this window originated the write, it is ignored; otherwise `applyStoreUpdate(key, state)` in [store-sync.ts](../src/store/store-sync.ts) applies it. `store-sync.ts` keeps a `SyncTarget` per key with `getState` (must return the same shape as the store's `partialize`), `setState`, and an optional `deserialize` (arrays back to `Set`s for `ui`). It runs `reconcile(current, incoming)` from [reconcile.ts](../src/lib/reconcile.ts) for structural sharing, and skips `setState` when the result is the current object.

Two details matter when changing this:

- zustand's `persist` wraps `api.setState`, so applying a remote update also schedules a write from the receiving window. Echo suppression therefore relies on `reconcile` returning the identical object when nothing changed; `reconcile` returns `incoming` whenever the key sets differ.
- The `worktrees` target merges only `customOrder`/`hiddenPaths` into existing `byProject` entries, so runtime worktree lists are never overwritten by persisted data. `keybindings` re-validates overrides through `parseBindingOverrides` and re-derives lookup state.

Known drift: the sync `getState` slices omit fields that `partialize` persists: `autoRevealInExplorer` (settings), `logTextFilter` (ui) and `autoExpandedProjectIds` (projects). For those stores every incoming update has more keys than the current slice, so it is always applied and re-written by the receiver. Reading the code, this can make windows bounce the same value back and forth; not verified at runtime.

### Versioning and migrations

- `stores.db` has no schema migrations; its schema is one key/value table.
- Persisted store shapes are versioned by zustand: `settings-store.ts` is at `version: 10` with a stepwise `migrate` (each `version <= n` block upgrades one step), and `keybinding-store.ts` is at `version: 1`. Stores without `version` rely on `merge` or default spreading to tolerate missing fields.
- Layouts carry their own `layoutVersion`; a mismatch discards the saved layout instead of migrating it (see below).
- `projects.db` creates its table if missing and imports a legacy `projects.json` once, renaming it to `projects.json.bak`.
- Review databases use `PRAGMA user_version` (currently 2).

## Layout persistence

Panel structure is described in [PANELS_AND_LAYOUT.md](PANELS_AND_LAYOUT.md); this section covers only storage. [PersistedLayout.tsx](../src/components/dockview/PersistedLayout.tsx) wraps `DockviewReact` and is mounted twice: `storagePrefix="outer"` in [App.tsx](../src/App.tsx) (layout version `LAYOUT_VERSION` in [default-layout.ts](../src/components/dockview/default-layout.ts)) and `storagePrefix="center"` in [CenterHost.tsx](../src/components/dockview/CenterHost.tsx) (`CENTER_LAYOUT_VERSION`). Both use the active worktree path as `layoutKey`, so each worktree has its own saved layout.

- **Keys.** Built only through [layout-key-schema.ts](../src/lib/layout-key-schema.ts), which is dependency-free so the renderer and `store-db.ts` share it. Each window writes its own `layout:session:<windowId>:...` rows; `layout:canonical:...` is the layout of the last window closed.
- **Value.** `JSON.stringify({ version, data: api.toJSON() })`.
- **Restore order** (`fetchLayout`): this window's session row (survives reloads); then, only if the window was the first one open (`IS_FIRST_WINDOW` in [window-id.ts](../src/lib/window-id.ts)), the canonical row; then a one-time migration of legacy localStorage layouts into canonical. Otherwise the default layout is built.
- **Writes.** Layout changes are debounced (500 ms) and skipped when the serialized snapshot equals the last saved one. Pending writes flush on `pagehide` with `fetch(..., { keepalive: true })`. On a worktree switch the old layout is cached in memory and written immediately, then the new one is restored from cache, server, or default.
- **Promotion.** When a window closes, Electron main calls `POST /api/layout/promote` with its window ID ([main.ts](../src/electron/main.ts)), and `promoteLayoutSession` moves that window's session rows to canonical in one transaction. The route accepts only UUID-shaped IDs so the `LIKE` prefix cannot match other windows' rows. New windows wait for in-flight promotions before reading.
- **Crash recovery.** On server boot, `recoverOrphanLayoutSessions` copies the most recent session row per `<scope>:<worktreePath>` to canonical and deliberately keeps the session rows, so renderers reloaded after a server crash still find their own layout.

Inner dockviews (for example the graph panel) are kept only in [worktree-cache.ts](../src/store/worktree-cache.ts). [layout-actions.ts](../src/store/layout-actions.ts) holds imperative collapse/expand logic that reads and writes `sidebarSizes` in the per-worktree tools-bar store; it does not persist anything itself. Layout rows are not deleted when a worktree is removed.

## Server state directory

[config.ts](../src/server/config.ts) resolves `stateDir` as `LOXEL_STATE_DIR`, else `~/.local/state/loxel/loxel-dev` when `LOXEL_DEV=1`, else `~/.local/state/loxel/loxel`. Dev and prod never share files (or a server, see [SHARED_SERVER.md](SHARED_SERVER.md)); the e2e setup ([global-setup.ts](../e2e/global-setup.ts)) points `LOXEL_STATE_DIR` at a temporary directory.

| Path                                             | Owner                                                                                                                                   | Notes                                                                                                                                                                 |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stores.db`                                      | [store-db.ts](../src/server/store-db.ts)                                                                                                | Client stores, layouts, external folders                                                                                                                              |
| `projects.db`                                    | [project-store.ts](../src/server/project-store.ts)                                                                                      | Registered projects; schema and add semantics in [PROJECTS_AND_WORKTREES.md](PROJECTS_AND_WORKTREES.md#project-model)                                                 |
| `comments/<repoHash>.db`                         | [review-db.ts](../src/server/review-db.ts)                                                                                              | Reviews, threads, comments; hash of the realpath of `git rev-parse --git-common-dir`, so all worktrees of a repo share one file. See [CODE_REVIEW.md](CODE_REVIEW.md) |
| `localdb/<hash12(projectPath)>/localdb.db`       | `@bizimind/localdb-sdk`, opened in [server.ts](../src/server/server.ts), served by [localdb-routes.ts](../src/server/localdb-routes.ts) | One per project; changes broadcast as `localdb_changed`. See [EDITOR.md](EDITOR.md)                                                                                   |
| `detached/<hash12(project)>/<hash12(worktree)>/` | `getDetachedDir` in [config.ts](../src/server/config.ts)                                                                                | Draft files                                                                                                                                                           |
| `logs/`                                          | [logger.ts](../src/server/logger.ts)                                                                                                    | See [SHARED_SERVER.md](SHARED_SERVER.md#persistent-state)                                                                                                             |
| `updates/`                                       | [update.ts](../src/server/update.ts)                                                                                                    | Downloaded updates and `pending.json`                                                                                                                                 |
| `data-encryption-key.enc`                        | Electron main, [dek.ts](../src/electron/dek.ts)                                                                                         | Wrapped data encryption key; see [Secrets](#secrets)                                                                                                                  |

All SQLite files are opened with `PRAGMA journal_mode = WAL` and `busy_timeout = 5000`. Server notifications are not persisted: [notification-store.ts](../src/server/notification-store.ts) is an in-memory list capped at 200 entries, lost on restart, and broadcast to clients by the caller.

Note: [dek.ts](../src/electron/dek.ts) computes its own state directory from Electron's dev flag and does not read `LOXEL_STATE_DIR`.

## Settings

[settings-store.ts](../src/store/settings-store.ts) is the single settings store. A setting is a typed field on `SettingsState` with a default in the state creator, a setter action, and an entry in `partialize`. The persisted slice is `models`, `codingAgent`, `layout`, `terminal`, `editor`, `schemas`, `fileAssociations` and `autoRevealInExplorer`; `isOpen` and `activeSection` (the modal's UI state) are not persisted.

- **UI.** [SettingsModal.tsx](../src/components/settings/SettingsModal.tsx) renders all sections in one scroll container; each `*Section.tsx` in [src/components/settings/](../src/components/settings/) reads fields with `useSettingsStore(selector)` and calls the store's setters.
- **Validation.** There is no schema validation of the persisted object. Shape changes go through the versioned `migrate`, which checks each field structurally before rewriting it. Builtin defaults for schemas and file associations stay in code (`BUILTIN_SCHEMA_DEFAULTS`, `BUILTIN_FILE_ASSOCIATIONS`); the persisted arrays hold only user entries and toggled builtins, merged at read time by `selectEffectiveSchemas` / `selectEffectiveFileAssociations`.
- **Server use.** The server never reads the `settings` row. Settings it needs travel with the request that needs them: schema mappings via `api.syncSchemas` ([schema-sync.ts](../src/lib/schema-sync.ts)), formatting options with saves ([save-editor-content.ts](../src/lib/save-editor-content.ts)), and model configuration in agent session options (`buildSessionOptions`).
- **Keybindings** are a separate persisted store; see [KEYBINDINGS.md](KEYBINDINGS.md).

## Secrets

Model API keys (`ModelEntry.apiKey` in the settings store) are the secrets the persistence layer handles.

- **Key material.** Electron main ([dek.ts](../src/electron/dek.ts)) owns a random 32-byte data encryption key (DEK). It is stored only wrapped by Electron `safeStorage` (OS-backed, the Keychain on macOS) in `data-encryption-key.enc` with mode `0600`. If `safeStorage` is unavailable, the app shows an error and exits. If the file cannot be unwrapped, a new DEK is generated, which makes previously encrypted values unreadable.
- **Hand-off.** [main.ts](../src/electron/main.ts) writes the base64 DEK as one line to the spawned server's stdin. On the server, [dek-source.ts](../src/server/dek-source.ts) picks the source: a fixed development key when `LOXEL_DEV=1`, a base64 file named by `LOXEL_DEK_FILE`, or otherwise one stdin line within 10 seconds. Keys of the wrong length are rejected. [keychain.ts](../src/server/keychain.ts) is a thin wrapper over the source.
- **Cipher.** [secret-store.ts](../src/server/secret-store.ts) uses AES-256-GCM with a random 12-byte IV and a 16-byte tag, encoded as `enc:v1:` + base64(iv, tag, ciphertext). `initSecretStore()` runs at server startup before projects load; `encrypt`/`decrypt` throw if it has not run.
- **Where it applies.** The `/api/stores/:key` route encrypts every non-empty `state.models[].apiKey` on PUT (leaving already-encrypted values untouched) and decrypts on GET, for store keys matched by `isEncryptedStoreKey` in [routes.ts](../src/server/routes.ts). A value that fails to decrypt is returned as `{ err }`, which the client types as `ApiKeyError` and `buildSessionOptions` skips.
- **Plaintext boundaries.** The renderer holds decrypted keys in memory, and `store_updated` broadcasts carry the plaintext state to every connected window.

## Browser storage

The renderer uses browser storage only where state is per window or must exist before the server answers:

- `sessionStorage[<prefix>-activeWorktreePath]` ([worktrees.ts](../src/store/worktrees.ts)): the active worktree, per window, restored on reload.
- `localStorage[<prefix>-window-id]` ([window-id.ts](../src/lib/window-id.ts)): the window ID outside Electron only; Electron windows get theirs from the main process.
- `localStorage[<prefix>-logs-last-seen-error-total]` ([panel-badges.ts](../src/store/panel-badges.ts)): logs badge bookkeeping.
- Legacy store and layout entries, read once for migration.

## Invariants

- **One writer per row.** Each persisted store key belongs to exactly one zustand store, and each `layout:session:<windowId>` row to one window. Server-owned keys (`external-folders:*`, canonical promotion) are never written by persist. Writes replace the whole value, so two windows writing the same key concurrently resolve as last write wins.
- **One process per state directory.** Only the server opens the SQLite files, and there is one server per state directory (see [SHARED_SERVER.md](SHARED_SERVER.md)). Electron main touches only `data-encryption-key.enc` and, when applying an update, `updates/` (see [SHARED_SERVER.md](SHARED_SERVER.md)).
- **Never persist** runtime server data (worktree lists, Git state, the project list from `projects.db`), per-window state (active worktree, window ID), non-JSON values without a `partialize`/`merge`/`deserialize` round trip (for example `Set`s in `ui.ts`), or secrets outside a field the server encrypts. Anything persisted is broadcast to all windows.
- **Settings stay client-owned.** The server receives settings as request parameters; do not make it read `stores.db` rows of client stores.

### Adding a persisted field

1. Add the field and its default to the store, and add it to `partialize`.
2. Add it to the store's `SyncTarget.getState` in [store-sync.ts](../src/store/store-sync.ts) with the same shape, plus `deserialize` if it is not plain JSON.
3. If older persisted data lacks the field and the default spread is not enough, bump `version` and add a `migrate` step (settings) or handle it in `merge`.
4. For a new persisted store, add a `createServerStorage("<key>")` instance in [server-storage.ts](../src/store/server-storage.ts) and a `SyncTarget` for the key. `server-storage.ts` also exports a `tools-bar` storage instance that no store currently uses.
5. If the field contains a secret, make sure the server encrypts it before it reaches `stores.db`; do not add secrets to other stores.

## Where to look

- [src/store/server-storage.ts](../src/store/server-storage.ts), [src/store/store-sync.ts](../src/store/store-sync.ts), [src/lib/reconcile.ts](../src/lib/reconcile.ts): client persistence and cross-window sync
- [src/store/worktree-store.ts](../src/store/worktree-store.ts), [src/store/worktree-cache.ts](../src/store/worktree-cache.ts): per-worktree store factory and cache
- [src/server/store-db.ts](../src/server/store-db.ts), `/api/stores/:key` and `/api/layout/promote` in [src/server/routes.ts](../src/server/routes.ts): server persistence
- [src/components/dockview/PersistedLayout.tsx](../src/components/dockview/PersistedLayout.tsx), [src/lib/layout-key-schema.ts](../src/lib/layout-key-schema.ts): layout storage
- [src/server/config.ts](../src/server/config.ts), [src/server/project-store.ts](../src/server/project-store.ts), [src/server/review-db.ts](../src/server/review-db.ts): state directory and databases
- [src/electron/dek.ts](../src/electron/dek.ts), [src/server/dek-source.ts](../src/server/dek-source.ts), [src/server/secret-store.ts](../src/server/secret-store.ts): secrets
