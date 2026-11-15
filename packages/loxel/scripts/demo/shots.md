# Site screenshots

The screenshots on the site's feature tour, staged in a hidden Loxel demo app and composited into a real macOS window frame. They tell one story: one developer, one morning, two projects, and everything on screen belongs to the task it's in. This file is the brief for whoever stages them: the story, the setup and the rules. Each shot's steps, prompts and proportions live in its script, `shots/<name>.ts`, and nowhere else.

## Setup

- `pnpm -C packages/loxel run demo` (`launch.ts`) clones the demo projects into `~/.loxel-demo` (`demo-projects.ts`), builds the app and starts a visible demo, instance 0 (port 7435, its own state and data). Look around in it; the captures don't need it running.
- `bun scripts/demo/capture-shots.ts [--instance <n>] [--build] <names...>` (from `packages/loxel`) captures shots in a hidden demo app (`LOXEL_DEMO_HIDDEN=1`) on instance n, port 7435 + n. The instance defaults to 1, clear of the visible demo; different instances run side by side, and a run stops at once if a demo app already answers on its instance. It clones the demo projects and builds the app if they are missing (`--build` rebuilds), resets the instance's state, widens the sidebar, turns off inlay hints, runs the shots and saves `packages/site/src/assets/screenshots/<name>.png`. On failure it saves what the window showed to `~/.local/state/loxel/loxel-demo-<n>-failure.png` (`loxel-demo-failure.png` for instance 0).
- The content is captured with `capturePage()` and composited (`composite.swift`) into `window-frame.png`, a real capture of one demo window (`capture-frame.ts`, rerun only when macOS's window style changes).
- Each shot is a script, `shots/<name>.ts`, exporting `default async function (s: Shot)`. `shot-kit.ts` has what they share: `s.loxel(project, task, ...args)` runs the `loxel` CLI inside a task's worktree (placement with `--focus`/`--no-focus`, `--split left|right|up|down` and `--group <file or tab title>`); `Terminals` waits for text in a terminal by its task's worktree and tab title; `group`, `groupOf`, `groupRect`, `panelPoint` and `taskArea` find panels by tab title, counting only tabs on screen (other tasks' layouts stay mounted, hidden); `dragDivider`, `typeInto`, `focusTerminal`, `scrollEditorTo`, `collapseSidebar`, `openBranchChanges`, `diffLine`, `clearLogsDot`, `parkMouse` and `until` drive the page; `s.cleanups` holds what must run once the shot is captured; and `Agent` with `agentCommand`, `acceptTrust` and `finishAgent` runs real agents. `shots/worktrees-agents.ts` is the reference shot.

## Rules for every shot

- **Size and zoom:** the window stays 1920×1200 (a large monitor's window) at Loxel's default zoom. Never zoom out.
- **Hand-set proportions:** drag dividers to the sizes the shot's script gives; never leave even 50/50 splits. The pane that carries the shot's point is the biggest; no pane is mostly empty.
- **Mind the page crop:** on the site each image bleeds off one edge. "Keep left" means the point of the shot must not be in the right third of the window; "keep right", not in the left third.
- **Sidebar:** collapsed (`collapseSidebar`) when a side panel (Project Files, Changes, Comments) is open; otherwise expanded, wide enough that no task title is cut off with "…", with both projects visible. Notification dots only where a shot asks for them.
- **Agents:** their first prompt is sent (they answer from the code; plan mode and a read-only sandbox mean they change nothing). Their second prompt is typed into the input but **never sent**. Accept a "trust this folder" prompt for the demo worktrees. Wait for the first answer to finish before capturing.
- **Prompts are plain questions,** the way a developer would ask them. How to answer for a screenshot (short, specific, read-only, no emails) lives in one place, `SCREENSHOT_BRIEF` in `shot-kit.ts`, never in a prompt.
- **Clean frame:** no caret, selection, open menu, tooltip or hover unless the shot asks for it; the runner parks the mouse before capturing. No warnings, update prompts, banners, empty states or half-loaded pages. If an agent shows a warning in its footer, find out what it is and clear it, or report it.
- **Nothing personal:** no emails, home folder paths, plan names, clipboard hints, or usage, rate-limit or billing notices. Real author names on commits and PRs are fine.
- **Check every capture** by opening the PNG and going over it region by region (sidebar, tab bars, each pane, status bar) against the shot's "Shows". Fix and recapture until it matches.

Agents (`agentCommand` in `shot-kit.ts`): Claude Code runs in plan mode with no away summary, the screenshot brief appended to its system prompt, and its plan name and clipboard hint blanked (`redact.py`); Codex runs under `redact.py` too, which blanks its usage-limit notices, with the instance's own Codex home, whose config makes it read-only and never asking, trusts the demo worktrees and holds the same brief as `AGENTS.md`. Neither changes anything, and the repos aren't modified.

## Shots

### 1. `worktrees-agents`: "Maximize a group" (keep left)

The lead task, with agents at work. Project `loxel`, task `maximize-group` (PR #1083). Steps in `shots/worktrees-agents.ts`.

Shows: the sidebar with both projects, the nested subtasks, a folded group with a dot; Claude Code's real answer and the typed follow-up; the PR's new tab menu entry in the editor; Codex's review answer and its typed follow-up; the PR's tests passing.

### 2. `worktrees-review`: "Hard-refresh tabs" (shown as a pair with shot 1)

The same window in another task, with a clearly different layout. Project `loxel`, task `hard-refresh` (PR #1052). Steps in `shots/worktrees-review.ts`.

Shows: the PR's real file list, its real split diff, a review with three readable comment threads (one open), and the PR's tab in the tab bar.

### 3. `agents`: "Self-host site fonts" (keep right)

Two agents on one task. Project `loxel`, task `site-fonts` (PR #1155). Steps in `shots/agents.ts`.

Shows: two real agents, each with a real answer and a typed follow-up; the site's dev server running, with the pages it served.

### 4. `browser`: "Selection color handles" (keep left)

The PR beside the change it makes. Project `excalidraw`, task `selection-color` (excalidraw#11006). Steps in `shots/browser.ts`.

Shows: the PR on GitHub in dark mode, from its title down; Loxel's drawing with only the arrow selected, so its point handles show exactly what the PR recolors.

### 5. `git`: "Worktree error toast" (keep right)

What's landing. Project `loxel`, task `worktree-toast` (PR #1107). Steps in `shots/git.ts`.

Shows: real history with real authors and dates, the task's branch in the graph, the PR's files and a real two-sided diff.

### 6. `editor`: `main` (keep left)

The code at a glance. Project `loxel`, task `main`. Steps in `shots/editor.ts`.

Shows: the file tree, real code filling the editor with no line cut off, and a hover card with a real type on `launchLoxel`, opened from the keyboard (Cmd+K Cmd+I): the one shot with a hover.

### 7. `markdown`: "Screenshots with soul" (keep right)

Plans next to the code. Project `loxel`, task `feature-tour`. Steps in `shots/markdown.ts`.

Shows: the plan for this very page (headings, the shot table, the checklist with "Take a screenshot of this plan" ticked) and an agent answering about it.
