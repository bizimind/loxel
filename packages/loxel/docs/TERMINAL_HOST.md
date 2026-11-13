# Terminal host

The terminal host is the part of Loxel that owns terminal sessions: the PTY and its program, the headless emulator, stream offsets and epochs, the resume ring, snapshots, flow control, and detection of notification sequences. Everything else about terminals is policy and stays in the server: which shell runs and with what environment, toolchains and the Python shim, which client a session streams to, orphans, worktree lifecycle, settings and notifications. The server reaches sessions only through the `TerminalHost` interface. Today one implementation exists, `InProcessTerminalHost`, which runs the sessions inside the server process. What a session does with its bytes (attach, snapshot, resume, flow control) is in [TERMINALS.md](TERMINALS.md#server-terminal-sessions).

## Modules

| Module                                                                          | Contents                                                                                                                                                                                           |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [terminal-host.ts](../src/terminal-host/terminal-host.ts)                       | The `TerminalHost` interface and the data it carries: `TerminalSpawnRequest`, `TerminalSessionInfo`, `TerminalAttachRequest`, `TerminalHostEvent`, `TerminalSessionMeta`, `OSC_NOTIFICATION_CODES` |
| [in-process-terminal-host.ts](../src/terminal-host/in-process-terminal-host.ts) | `InProcessTerminalHost`: sessions by ID with their meta, event delivery to listeners                                                                                                               |
| [terminal-session.ts](../src/terminal-host/terminal-session.ts)                 | `TerminalSession` (one PTY plus its emulator) and `OutputRing`                                                                                                                                     |
| [index.ts](../src/terminal-host/index.ts)                                       | The module's public API, which the server imports                                                                                                                                                  |
| [terminal-manager.ts](../src/server/terminal-manager.ts)                        | The server's side: `TerminalManager`, the host's only caller                                                                                                                                       |

## The boundary

Nothing under `src/terminal-host/` imports from `src/server/`, directly or through what it imports, so the host can run without the server and outlive it. [import-boundary.test.ts](../src/terminal-host/import-boundary.test.ts) walks the import graph of every file in the folder, type imports included, and fails with the chain of imports that reaches a server module. What both sides need lives where neither pulls in the other, and imports nothing itself:

- [terminal-stream.ts](../src/api/terminal-stream.ts): `TerminalState`, what a `state` event carries and `terminal_state` forwards, next to the binary frame codec the renderer and the server share.
- [terminal-limits.ts](../src/api/terminal-limits.ts): the size and scrollback bounds and their clamps, which the host enforces whatever it is sent.

The host never reads settings. What the process running it provides is passed in as a `TerminalSessionRuntime`: a logger (typed by `ChildLogger` from [log-entry-model.ts](../src/api/log-entry-model.ts)), and optional hooks for spawn accounting and the stress detector. `server.ts` gives the in-process host the `terminal` log category, `measureSpawn` and the `pty-output` checkpoint.

## The interface

Everything that crosses the interface is plain data: strings, numbers, JSON objects and `Uint8Array` payloads. Commands return nothing or a promise of data, and everything the host has to say arrives as an event, so the interface can be carried over a socket without callbacks into the server.

**Commands**

| Command                                                                                               | Effect                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `spawn({ id, epoch, argv, cwd, env, cols, rows, scrollbackLines, meta, input? })`                     | Start a session and resolve to its `TerminalSessionInfo`. The caller picks the `epoch`, a random UUID per spawn. `argv` and `env` are complete: the host adds no shell and inherits no environment. `input` is written to the PTY first, typed ahead. Rejects, with the cause, if the ID is in use or the program cannot start |
| `list()`                                                                                              | Every session: `{ id, epoch, offset, pid, cols, rows, meta }`                                                                                                                                                                                                                                                                  |
| `attach({ id, attachment, since? })`                                                                  | Bind the client, replacing any attached one; resolves once its `state` event is out, or once it was superseded                                                                                                                                                                                                                 |
| `detach(id)`                                                                                          | Stop sending output; the program keeps running and its output keeps being parsed                                                                                                                                                                                                                                               |
| `write(id, data)`, `resize(id, cols, rows)`, `setScrollback(id, lines)`, `ack(id, syncOffset, bytes)` | As in [TERMINALS.md](TERMINALS.md#server-terminal-sessions)                                                                                                                                                                                                                                                                    |
| `destroy(id)`                                                                                         | Hang up and kill the program; the session is gone at once                                                                                                                                                                                                                                                                      |
| `setMeta(id, meta)`                                                                                   | Replace the session's meta                                                                                                                                                                                                                                                                                                     |
| `onEvent(listener)`                                                                                   | Subscribe to events; returns the unsubscribe function                                                                                                                                                                                                                                                                          |

A command naming an unknown ID does nothing, since a session can end on its own at any time.

**Events**

| Event                           | When                                                                                                 |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `state { attachment, state }`   | For every attach and every flow-control resync, before any output at or past `state.offset`          |
| `output { id, offset, data }`   | Output for the attached client, in offset order, only after that client's `state`                    |
| `exit { id, epoch, exitCode }`  | The program ended on its own, after any final resync of a paused client; the session is already gone |
| `osc { id, epoch, code, data }` | The emulator parsed OSC 9, 777 or 99, attached or not; `data` is the raw payload                     |

**Meta.** Each session carries a JSON object the server sets at spawn and with `setMeta`, and reads back with `list()`. The host stores it as given and never looks inside, so the server can keep new fields there without changing the host. The server's shape is `TerminalMeta` in [terminal-manager.ts](../src/server/terminal-manager.ts): the panel's `worktreePath` (null for a Home terminal), the shell's starting `cwd`, and the creating `windowId`.

**Notifications are reported raw.** The host reports every OSC 9, 777 and 99 sequence with its payload, unfiltered and unparsed. The manager drops the ones the settings disable and reads the rest with [osc-notification-parser.ts](../src/lib/osc-notification-parser.ts), so a change to the settings or the parsers never involves the host.

## Ordering

The interface promises an order that does not depend on the host running in the same process:

- Commands apply in the order they are sent. `spawn()` registers the session before it returns, so a `write`, `attach` or `destroy` sent before it resolves applies to the new session. Events of the new session, an `exit` included, can likewise arrive before the spawn's answer.
- A session's `state` precedes the output that follows it, and its `exit` comes last.

The manager relies on that order, not on timing, to tell which events are current, because events already on their way can be stale by the time they arrive:

- **Attachments.** Every attach carries an `attachment` number, unique across the manager's attaches, and the host echoes it on every `state` that attach produces. The manager forwards a state only when it matches the session's latest attach, and forwards output only after that state, so a resync or output meant for a client that has since been replaced never reaches its successor. Numbers only have to be unique among the attaches one caller sends to one host: the host keeps only the latest attach per session and never compares numbers, so a server that starts over begins its own sequence. Output frames themselves stay in the renderer's frame layout, without an attachment.
- **Epochs.** `exit` and `osc` carry the session's epoch. The manager picks the epoch of each spawn, so it knows it before any event of the session can arrive, and a session destroyed and respawned under the same ID gets a new one: an exit or notification from the earlier spawn does not end or notify its replacement.
- **Destroy is silent.** A destroyed session never sends `exit`, even when its program ends later. This is part of the contract: the manager removes the session itself when it asks for the destroy, and the `onExit` hook is only for programs that ended on their own.

## The server's side

`TerminalManager` keeps, per session, the meta, the epoch, the host's answer to the spawn, the client's sink, the latest attachment and whether that client has received its state. A client owns the session from the moment it attaches, before the host has answered the spawn: a detach or a later attach in that window takes effect, the session is not an orphan meanwhile, and only the client that owns the session once the spawn is answered is attached in the host. An attach waiting on a spawn the host refuses fails with it. It never asks the host for these; the host's `list()` is what a caller that did not spawn the sessions itself would read them from. Pending starts (a shell waiting for its toolchain environments) live only in the manager: the host is asked to spawn once the environment is ready, with the latest size, the command and any input typed ahead, in that order. A worktree move updates the meta in both places; removal, orphan cleanup and shutdown call `destroy`.

## Tests

- [terminal-session.test.ts](../src/terminal-host/terminal-session.test.ts): the ring, snapshots, resume, flow control, raw notification sequences and exit, on one session.
- [in-process-terminal-host.test.ts](../src/terminal-host/in-process-terminal-host.test.ts): the interface: spawn and list, typed-ahead input, attachments on states, events, destroy and ID reuse, rejected spawns, unknown IDs.
- [terminal-manager.test.ts](../src/server/terminal-manager.test.ts): the policy against the in-process host, and, against a fake host, events that arrive stale.
- [import-boundary.test.ts](../src/terminal-host/import-boundary.test.ts): the boundary.
