# Agent overlay

The agent overlay is a rich view of a Claude Code session running in a terminal panel. It is not a second agent: the session is the `claude` TUI process in the terminal, and the overlay reads what that process reports and types into its PTY. The terminal stays mounted under the overlay, so switching between the two views is instant and both always show the same session.

## Data flow

```
claude (TUI, in the PTY) ──hooks──► curl ──► POST /api/agent-overlay/hook ──► AgentOverlayService
        │                                                                     │  AgentSession per terminal
        └──writes──► transcript JSONL ──TranscriptTailer──────────────────────┤
                                                                              ├─► agent_session (all windows)
terminal host (headless xterm) ◄──screen()── claude-screen.ts recognizers ◄───┤   agent_transcript (subscribers)
        ▲                                                                     │
        └──────────── PTY input ◄── claude-driver.ts ◄── POST /api/agent-overlay/action
```

Three sources, each used only for what it is reliable at:

| Source     | Read by                                                                  | Gives                                                                                                                                                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hooks      | [agent-session.ts](../src/server/agent-overlay/agent-session.ts)         | Session ID, transcript path, state (working, needs input, idle, failed, ended), permission mode, model, effort, and the interaction Claude waits on, with its structured input (AskUserQuestion's questions, the plan, a permission request's tool input and suggestions) |
| Transcript | [claude-transcript.ts](../src/server/agent-overlay/claude-transcript.ts) | The conversation: prompts, replies, thinking, tool uses with their results, slash commands with their output, compactions, the session title                                                                                                                              |
| Screen     | [claude-screen.ts](../src/server/agent-overlay/claude-screen.ts)         | Only whether a known dialog is up and which choices it shows, worded as the terminal words them; the permission mode in the footer                                                                                                                                        |

The conversation is never scraped from the screen.

## Hooks

[claude-hooks.ts](../src/server/agent-overlay/claude-hooks.ts) defines one shell command, `CLAUDE_HOOK_COMMAND`, registered for every event in `CLAUDE_HOOK_EVENTS`. It posts the hook's stdin to `http://127.0.0.1:$LOXEL_PORT/api/agent-overlay/hook` with the terminal's `LOXEL_TERMINAL_ID` and `LOXEL_AGENT_TOKEN` as headers, prints nothing (a hook's stdout is read as a decision) and always exits 0, so a Loxel that is gone or slow never alters Claude. Without `LOXEL_AGENT_TOKEN` it does nothing, so the same command is harmless outside Loxel.

`server.ts` adds both variables to every terminal's environment (`terminalSpawnTarget`). The token is an HMAC-SHA256 of the terminal ID with a key in `<stateDir>/agent-overlay/hook.key`, so it survives a server restart (terminals outlive the server in the terminal host) without being stored per terminal. A hook with a wrong token is a 403; one for a terminal the server does not run is ignored.

**New Claude Code Terminal** (`panel.new.claude`) is how the hooks reach a `claude`: it runs `claude --settings <stateDir>/agent-overlay/claude-hooks.json` through `POST /api/open`, like `loxel terminal`. The settings file holds only the hooks and is merged by Claude Code over the user's settings for that session; nothing of the user's changes. A `claude` started any other way reports nothing and stays a plain terminal.

## Sessions

`AgentOverlayService` ([agent-overlay-service.ts](../src/server/agent-overlay/agent-overlay-service.ts)) keeps one `AgentSession` per terminal ID, created by the first hook. A hook naming a different transcript (`/clear`, a resumed session) restarts the transcript. A session ends with its terminal (`removeTerminal`, from the terminal's exit, destroy and worktree removal paths in `server.ts`), not with `SessionEnd`, which only sets the state.

Every summary change is broadcast to all windows as `agent_session` (and the full list as `agent_sessions_sync` on connect); repeats are skipped. Transcript items go only to the sockets that sent `agent_subscribe` for the terminal, as `agent_transcript`: a `reset` with all items on subscribe, then upserts by item ID (a tool's result replaces its tool item). The model is [agent-overlay-model.ts](../src/api/agent-overlay-model.ts).

**Interactions.** `PreToolUse` of AskUserQuestion or ExitPlanMode and `PermissionRequest` of any other tool set the pending interaction; a permission or elicitation `Notification` with nothing pending sets an `unknown` one, which the renderer can only send to the terminal. `PostToolUse`, `PostToolUseFailure`, `PermissionDenied`, `UserPromptSubmit`, `Stop` and `StopFailure` clear it. A dialog answered in the terminal sends no hook, so while an interaction is pending the service reads the screen every 750 ms: a recognized dialog fills `dialogOptions` (the choices as the terminal words them, which the cards show), and a dialog seen and then missing for three reads in a row dismisses the interaction. A dialog never recognized is left to the hooks, so an unknown layout cannot be dismissed by mistake. A refusal or an interrupt from the overlay ends the turn without a `Stop` hook, so the action marks the session idle itself.

## Screen and input

The terminal host's `screen(id)` ([TERMINAL_HOST.md](TERMINAL_HOST.md)) returns the visible rows as text. `recognizeDialog()` knows four dialogs, each by an anchor line below the input box (text above an input box is conversation): the permission prompt (`Do you want to …?`), the plan approval (`Would you like to proceed?`), AskUserQuestion pages (the tab bar, `←  ☐ Color  ✔ Submit  →`, or `☐ Size` for one question) and their review page (`Ready to submit your answers?`). Anything else, the workspace trust prompt included, is null.

[claude-driver.ts](../src/server/agent-overlay/claude-driver.ts) turns an action into keys. Each step looks at the screen first and waits for its effect before the next (arrow by arrow, each confirmed), and the first surprise throws `FallbackError`, which the renderer shows with **Continue in terminal**; nothing is typed after it. Prompts are pasted as bracketed paste, refused while a dialog is up or while the input box holds a draft typed in the terminal, and refused if they contain control characters. Permission choices are picked by their wording (`permissionDecisionOf`), never by position, and the renderer sends only the decision, never rules. Mode changes cycle Shift+Tab until the footer shows the mode. Model and effort are `/model <name>` and `/effort <level>`. Actions on one terminal run one at a time.

**Commands and models** come from Claude itself: [claude-catalog.ts](../src/server/agent-overlay/claude-catalog.ts) starts `claude -p` in stream-json mode in the user's home directory (not the session's: print mode skips the workspace trust prompt, so a repository's own hooks and MCP servers would run), sends the `initialize` control request and reads its commands, skills and models from the answer, with no model turn. Cached per directory for 5 minutes.

## Renderer

[store/agent-overlay.ts](../src/store/agent-overlay.ts) mirrors the sessions and subscribed transcripts. `TerminalPanelComponent` ([panels.tsx](../src/components/dockview/panels.tsx)) covers the terminal with [AgentOverlay](../src/components/agent-overlay/AgentOverlay.tsx) while the terminal has a session and the panel's `view` param ([terminal-view.ts](../src/components/agent-overlay/terminal-view.ts)) is not `terminal`; the terminal underneath is `inert`, so it neither takes focus nor resizes. The terminal tab shows the state as a dot and the view toggle. Transcript prose uses the markdown editor's typography ([agent-overlay.css](../src/styles/agent-overlay.css)) and Shiki for code. Images in agent output are shown as text and never loaded, and links open only when they are external http(s), so a prompt injection cannot make the view fetch or open anything.

## Fixtures

The recognizers and the driver are tested against screens recorded from a real Claude Code (`fixtures/claude-<version>/`), with the hooks and transcript of the same session. `scripts/capture-claude-tui.ts <out-dir>` records them again (a few short Haiku turns); sanitize paths and account details before committing. A Claude Code release that changes a dialog shows up as a failing fixture test after re-recording, and in the app as a fallback to the terminal, never as a wrong answer.
