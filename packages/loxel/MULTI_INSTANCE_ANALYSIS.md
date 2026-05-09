# Loxel Multi-Instance Concurrency Analysis

## Context

Loxel is a local-first IDE that runs as a Bun HTTP/WebSocket server (optionally wrapped in Electron). Today it assumes a single running instance per mode (dev/prod). This analysis evaluates every server-side subsystem for correctness when the same user runs multiple instances concurrently — e.g., opening multiple app windows — against the same repos and shared state directory (`~/.local/state/loxel/loxel/`).

---

## Part 1: Subsystem Concurrency Analysis

### 1. Port Binding — BLOCKER (single-instance assumption)

**Files:** `src/server/config.ts:27`, `src/server/index.ts:681-682`

The port is hardcoded: `7433` (prod) / `7434` (dev). `Bun.serve()` binds to `127.0.0.1:PORT`. A second server instance crashes immediately with `EADDRINUSE`.

---

### 2. FS Watch Guards — IN-PROCESS ONLY, CROSS-INSTANCE BLIND SPOTS

All watcher debounce/suppression state is per-process. Each instance independently reacts to filesystem changes, including changes caused by the other instance. This section is relevant to Approach A (multiple servers); Approach B (shared server) eliminates these concerns entirely.

#### 2a. FileWatcher & Status Suppress — NO CROSS-INSTANCE LOOP

**Files:** `src/server/file-watcher.ts`, `src/server/index.ts:101,142-165`

The concern: `git -c core.fsmonitor=true status` updates the index (to refresh fsmonitor extension data), which triggers the FileWatcher's `"status"` event. Within a single instance, the `statusSuppressUntil` guard (700ms window) prevents this from becoming an infinite loop. But does it work cross-instance?

**Yes — the loop is broken cross-instance.** Trace:

1. T=0: External index change detected by both watchers
2. T=150ms: Both watchers' debounce fires, both call `handleStatusEvent()`
3. T=150ms: Both pass suppress check (timer expired/0), both call `getStatus()`
4. ~T=200ms: Both `getStatus()` complete (modifying index via fsmonitor), both set `statusSuppressUntil ≈ T+900ms`
5. T=200ms: A's index write triggers B's watcher, B's write triggers A's
6. T=350ms: Watcher debounce fires → `handleStatusEvent()` → suppress check: `350 < 900` → **SUPPRESSED**

The 700ms suppress window comfortably covers the 150ms watcher debounce.

**Index lock for `git status`:** `git status` with fsmonitor uses a try-lock approach for index updates — if it can't acquire `.git/index.lock`, it skips the fsmonitor update and proceeds with potentially stale data. No user-facing error.

**Impact:** Both instances run `git status` independently on the same repo — correct behavior, each needs its own view. Doubles the git command load but no correctness issue.

#### 2b. ProjectFilesService (`src/server/project-files-service.ts:352`)

- Recursive `fs.watch()` on worktree root, 300ms debounce, all in-process
- `dirCache`, `pendingFsEvents`, status maps — all instance-local
- **Impact:** Each instance independently tracks the file tree and runs `git status` for status colors. Correct but duplicates work.

#### 2c. File Write Nonce System — EXPECTED BEHAVIOR

**Files:** `src/server/index.ts:237-245`, `src/server/routes.ts:485-505`

`ProjectState.fileWriteNonces` is an in-memory `Map<string, string>`. When Instance A's client saves a file, Instance A stores a nonce and writes to disk. Instance B's `ProjectFilesService` watcher fires — Instance B has **no nonce**, so it broadcasts `file_content_changed` with `nonce: null`.

Instance B's clients see this as an external file change — which it is, from their perspective. This is **expected and correct** behavior for a multi-window setup. The file genuinely changed from outside Instance B. Clients should handle this the same way they handle any external edit (e.g., from a terminal or another editor).

#### 2d. DetachedFilesService Nonces — EXPECTED BEHAVIOR

**Files:** `src/server/index.ts:220-221`

Same pattern as 2c for draft files. Instance B sees Instance A's draft writes as external changes. This is expected — in a same-user multi-window scenario, the user is aware they have the same draft open in two windows, and "external change" is the correct signal.

#### 2e. Status Suppress Timer — SAFE

Per-instance `statusSuppressUntil` timestamp prevents git-status retrigger loops. Each instance manages its own suppression independently. No cross-instance issue — covered in 2a above.

#### 2f. Debounced Worktree Status Broadcast — DUPLICATIVE

`projectWtStatusTimers` is per-instance. Both instances may run `getDirtyWorktreeStatuses()` concurrently. Correct but wasteful — performance cost, not correctness.

**Summary for FS Watchers:** No correctness bugs and no infinite loops. The nonce system causes "external change" signals in the other instance, which is the correct behavior. Main cost is doubled git command load.

---

### 3. SQLite (ReviewDb) — SAFE

**File:** `src/server/review-db.ts`

- WAL mode (`PRAGMA journal_mode = WAL`) — concurrent readers + one writer
- 5-second busy timeout (`PRAGMA busy_timeout = 5000`) — handles write contention
- Schema migration (`migrateToV2`) uses `CREATE TABLE IF NOT EXISTS` — idempotent
- All write operations use `db.transaction()` for atomicity

SQLite WAL mode is explicitly designed for multi-process access. Concurrent reads are lock-free. Write contention is handled by the busy timeout (writer retries for up to 5s).

**No fix needed.**

---

### 4. projects.json — RACE CONDITION

**File:** `src/server/project-store.ts`

`addProject()`, `removeProject()`, `updateProject()` all follow a read-modify-write pattern with no locking. Two processes adding projects simultaneously can lose one write:

1. A reads `[X]`, B reads `[X]`
2. A writes `[X, Y]`
3. B writes `[X, Z]` — **Y is lost**

**Recommendation:** Migrate to SQLite (same pattern as ReviewDb). This also simplifies the schema — we only need to store the project path since everything else (`isBare`, `name`, etc.) is reconstructed on startup from the repo itself. A single `projects` table with a `path TEXT PRIMARY KEY` column, using WAL mode, eliminates the race entirely. Under Approach B (shared server), the race is less likely since all requests go through one process, but SQLite is still the right move for robustness.

---

### 5. File Operations & Git Commands — MODERATE RISK (Approach A only)

Under Approach B, all git operations are serialized through one server process, so index.lock contention between windows doesn't occur. This section applies to Approach A.

#### 5a. FileOperationsService Queue (`src/server/file-operations-service.ts:162`)

The `enqueue()` Promise chain serializes operations within a single instance. No cross-instance serialization — two instances can run file ops on the same worktree concurrently.

#### 5b. Git Index Contention

Write operations (`git add`, `git commit`, `git checkout`, `git mv`, `git rm`, etc.) all acquire `.git/index.lock`. If Instance A holds the lock, Instance B's git command fails with: `fatal: Unable to create '.git/index.lock': File exists`.

Read operations (`git status`, `git diff`, `git log`, `git show`) do not require exclusive index.lock. `git status` with fsmonitor uses a try-lock — if the lock is held, it skips the fsmonitor update gracefully.

The FileWatcher already filters `.lock` files (`file-watcher.ts:93`), so index.lock creation/deletion won't trigger spurious watcher events.

**Recommendation:** Background operations like `git status` (triggered by watchers, not user action) should retry with backoff — they're read operations where index.lock contention from fsmonitor is transient. User-initiated git write operations should catch index.lock errors and surface a clear message.

#### 5c. Undo/Redo Stacks

Each instance maintains its own stacks in memory. Instance A's undo knows nothing about Instance B's operations. If A renames `foo.ts → bar.ts` and B deletes `bar.ts`, A's undo will fail.

**Accept as inherent:** Undo/redo is per-session state. The failure is no different from undoing after an external tool modifies the file.

#### 5d. Raw FS Operations (untracked files)

`rename()`, `rm()`, `copyFile()` on untracked files have no locking beyond the OS filesystem. Two instances operating on the same untracked file simultaneously is a race. Low probability.

---

### 6. Update System — MODERATE RISK

**File:** `src/server/update.ts`

- `downloadUpdate()`: Both instances may download the same archive concurrently. `Bun.write()` to the same path is not atomic — concurrent writes could produce a corrupt file. However, the SHA256 verification after download catches this.
- `prepareInstall()`: Writes `pending.json` synchronously — last writer wins.
- `cleanupStaleUpdates()`: On startup, deletes `pending.json` and `.tar.gz` files — could delete another instance's in-progress download.

Under Approach B, these problems vanish — one server, one update check, one download.

---

### 7. Log Files — ALREADY SAFE

**File:** `src/server/logger.ts`

Each instance generates a unique `instanceId` and writes to `server-{instanceId}.log`. `cleanupStaleLogs()` only removes logs older than 24 hours from other instances. Ring buffer is per-instance.

**Already designed for multi-instance. No fix needed.**

---

### 8. Orphaned Temp Worktree Cleanup — LOW RISK

**File:** `src/server/index.ts:76-97`

Currently uses `loxel-tmp-` prefix to identify temp worktrees. On startup, all temp worktrees are force-removed. If Instance B starts while Instance A has an active temp worktree, B prunes it.

**Recommendation:** Use instance ID as prefix instead of `loxel-tmp-` (e.g., `loxel-{instanceId}-`). Each instance only prunes its own temp worktrees on startup. On shutdown, clean up own temp worktrees. Add stale detection (check if creating PID is alive) for crash recovery.

---

### 9. Detached Files — SAFE

**File:** `src/server/detached-files-service.ts`

- `createFile()` uses `writeFile(path, content, { flag: "wx" })` — atomic, safe for concurrent access
- `writeFileContent()` uses `Bun.write()` — last writer wins (acceptable for same-user scenario)
- `renameFile()` has a TOCTOU stat-then-rename race, but low probability

**No fix needed** — draft file conflicts are inherently a user awareness issue in multi-window setups.

---

## Part 2: Architecture — Shared Server (Recommended)

### Why Shared Server

A single server process serving all Electron windows is the better approach because:

1. **Eliminates an entire class of problems permanently.** No git index.lock contention, no FS watcher duplication, no projects.json race, no update system coordination, no cross-instance nonce blindness. Every future feature that touches the filesystem or state works correctly by default — no multi-process safety review needed.

2. **More performant.** One set of watchers, one `git status` run per event, one SQLite connection, shared caches (dirCache, TypeScript language service, status maps). Resource usage is constant regardless of window count.

3. **Simpler lifecycle than it appears.** The server auto-shuts down after an idle timeout when no clients are connected. No PID files, no "who shuts down" coordination.

### Server State — Already Multi-Client

The server is already designed for multiple concurrent WebSocket clients:

| Tier                  | Scope             | Lifecycle                     | Multi-client?                                                 |
| --------------------- | ----------------- | ----------------------------- | ------------------------------------------------------------- |
| **ProjectState**      | Per repo          | Server lifetime               | Yes — shared, broadcasts to all                               |
| **WorktreeResources** | Per worktree      | First sub → last unsub        | Yes — `subscribers` Set, broadcasts to all                    |
| **ClientState**       | Per WS connection | WS open → close               | Yes — per-connection terminals & subscriptions                |
| **terminalOwners**    | Per terminal      | Terminal create → destroy     | Yes — routes output to owning WS connection                   |
| **agentOwners**       | Per agent         | Agent create → detach/destroy | Yes — routes events to owning WS, supports ownership transfer |

The only component that needs refactoring is `YamlLspManager`.

### What Changes

#### 1. Server Lifecycle — Idle Auto-Shutdown

Add an idle timer to the server. When the last WebSocket client disconnects, start a countdown (e.g., 30 seconds). If a new client connects before it fires, cancel. If it fires, graceful shutdown.

```
// Pseudocode in index.ts websocket.close handler:
clients.delete(ws);
if (clients.size === 0) startIdleShutdownTimer();

// In websocket.open handler:
cancelIdleShutdownTimer();
clients.set(ws, ...);
```

**Files:** `src/server/index.ts` — add idle timer logic around `clients` Map.

#### 2. Electron — Discover or Spawn

On app ready, Electron tries to connect to the well-known port. If the server is already running (another window started it), connect and proceed. If not, spawn the server and wait for it to become ready.

```
// Pseudocode in electron/main.ts:
app.whenReady().then(async () => {
  const running = await isServerRunning(SERVER_URL);
  if (!running) {
    startServer();
    await waitForServer(SERVER_URL);
  }
  createWindow();
});
```

**Edge case — two windows start simultaneously:** Both try to spawn. The second spawn's server fails with `EADDRINUSE` and exits. The spawning Electron detects the failure and falls back to connecting to the existing server. Simple and self-healing.

**Files:** `src/electron/main.ts` — add `isServerRunning()` check, handle spawn failure fallback.

#### 3. Electron — Window Close vs App Quit

No Electron needs to explicitly shut down the server. The server shuts itself down when no clients remain for the idle period. Electron just disconnects (WS close) and the server handles the rest.

For updates: the Electron that originally spawned the server has the `serverProcess` handle and receives exit code 42. Other windows' WS connections drop — they reconnect in a loop until the new server is up after the update. The WS client already has a 2-second reconnect loop (`src/api/client.ts`).

**Files:** `src/electron/main.ts` — simplify `before-quit` (no need to `killServer()` for non-spawning windows).

#### 4. YamlLspManager — Multiple Connections

Currently a singleton: one `proc`/`ws`/`stdoutBuf`. On new WS attach, kills previous process. Already structured as "one LSP process per WS client" — just doesn't support >1 client simultaneously.

Fix: change from single fields to a `Map<ServerWebSocket, YamlLspSession>` where each session has its own `proc`, `stdoutBuf`. `attach()` adds an entry, `detach()` removes and kills it. The rest of the logic (Content-Length framing, schema injection, stderr logging) stays identical per-session.

**Files:** `src/server/yaml-lsp-manager.ts` — refactor to Map-based multi-session.

#### 5. projects.json → SQLite (Optional but Recommended)

With a shared server, all project add/remove operations go through one process, so the JSON race is less likely. But SQLite is still the right move: simpler code (no read-modify-write), robust against edge cases, and the schema simplifies to path-only since everything else is reconstructed on startup.

**Files:** `src/server/project-store.ts` — rewrite with `bun:sqlite`.

### What Stays the Same

- **Port:** Keep the well-known port (`7433`/`7434`). Only one server runs.
- **All FS watchers:** Unchanged. One server = one set of watchers.
- **Nonce system:** Works correctly — all clients share the same nonce store, so the writing client's echo is suppressed and other clients are correctly notified.
- **Git operations:** All serialized through one process. No index.lock contention between windows.
- **Terminal/agent ownership:** Already per-WS-connection. Window A's terminals are invisible to Window B. Correct.
- **Undo/redo:** Per `WorktreeResources` (per worktree). If two windows view the same worktree, they share the undo stack — arguably correct since they're operating on the same filesystem.
- **ReviewDb:** Unchanged. One server, one SQLite connection per repo.
- **Logger:** Unchanged. One server instance, one log file.
- **Update system:** One server checks for updates, one download. No coordination needed.
- **Temp worktree cleanup:** Still worth using instance-scoped prefix for crash recovery.
- **Detached files:** Unchanged.
- **WebSocket protocol:** Unchanged. No new message types needed.
- **Client-side code:** Unchanged. The React frontend already connects to whatever host served the page. The 2-second WS reconnect loop handles server restarts.

### Behavioral Notes

| Scenario                                                        | Behavior                                                                                                                     |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Window A saves file, Window B has same file open                | Window B receives `file_content_changed` with `nonce: null` → treats as external change. Correct.                            |
| Window A renames file in explorer, Window B views same worktree | Window B receives `files_dir_changed` broadcast. Correct — already handled.                                                  |
| Window A creates terminal, Window B views same worktree         | Terminal is scoped to Window A via `terminalOwners`. Window B doesn't see it.                                                |
| Window A's Electron crashes                                     | WS disconnects. Server detects, cleans up A's terminals. B unaffected.                                                       |
| All windows close                                               | Server idle timer starts. After 30s, graceful shutdown.                                                                      |
| Server crashes                                                  | All windows' WS connections drop. Reconnect loop retries. Next window interaction that fails to connect spawns a new server. |
| Update ready, server exits 42                                   | Spawning Electron handles install + relaunch. Other windows reconnect after restart.                                         |

---

## Summary

| Subsystem             | Status                          | Action Needed                                           |
| --------------------- | ------------------------------- | ------------------------------------------------------- |
| **Port binding**      | Blocker (one server assumption) | Keep well-known port, add discover-or-spawn to Electron |
| **Server lifecycle**  | New                             | Add idle auto-shutdown timer                            |
| **Electron startup**  | Change                          | Try connect → spawn if needed → wait → create window    |
| **YamlLspManager**    | Refactor                        | Singleton → `Map<WS, Session>`                          |
| **projects.json**     | Optional improvement            | Migrate to SQLite (path-only schema)                    |
| **FS watchers**       | Already safe                    | None (one server = one set of watchers)                 |
| **Nonces**            | Already safe                    | None (shared nonce store, correct behavior)             |
| **SQLite (ReviewDb)** | Already safe                    | None                                                    |
| **Git operations**    | Already safe                    | None (serialized through one process)                   |
| **Terminals/agents**  | Already safe                    | None (per-WS ownership)                                 |
| **Undo/redo**         | Acceptable                      | Shared per-worktree (correct for shared filesystem)     |
| **Update system**     | Already safe                    | None (one server, one check)                            |
| **Log files**         | Already safe                    | None                                                    |
| **Temp worktrees**    | Minor                           | Use instance-scoped prefix                              |
| **Detached files**    | Already safe                    | None                                                    |

## Implementation Order

1. **Server idle auto-shutdown** — add timer to `index.ts`, shut down when 0 clients for N seconds
2. **Electron discover-or-spawn** — check if server running, spawn only if not, handle race
3. **YamlLspManager multi-session** — `Map<WS, Session>` refactor
4. **projects.json → SQLite** — path-only schema, WAL mode
5. **Temp worktree instance prefix** — `loxel-{instanceId}-`
