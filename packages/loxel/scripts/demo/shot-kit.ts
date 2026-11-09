/**
 * What the shots in shots/ share: reading terminals, finding and resizing panels, typing, and
 * driving real agents. Each shot is a function of a `Shot`; see capture-shots.ts and shots.md.
 */
import { resolve } from "node:path";

import { shellQuote } from "@bizimind/wt/lib";
import type { Locator, Page } from "@playwright/test";

import { BIN_MSG_OUTPUT, parseOutputFrame } from "../../src/api/ws-protocol";
import type { DemoSession } from "./demo-session";

/** How long an agent may take to answer; real requests to real models. */
export const AGENT_MS = 180_000;

/** What a shot gets: the demo session, its terminals, and the demo's Codex home. */
export interface Shot extends DemoSession {
  terminals: Terminals;
  codexHome: string;
  /**
   * Run by the runner once the shot is captured, then emptied: for what a shot must keep doing
   * until the capture (it returns before it) but must not leave running for the next shot.
   */
  cleanups: (() => Promise<unknown>)[];
}

// ── Terminals ──────────────────────────────────────────────────────────────

/** A terminal tab: its task's worktree and its title. Tasks reuse titles ("claude"). */
export interface TerminalRef {
  worktree: string;
  title: string;
}

const terminalKey = ({ worktree, title }: TerminalRef) => `${worktree}\0${title}`;

/**
 * An escape sequence cut off at the end of `text`: a lone ESC, a CSI without its final byte, or
 * an OSC without its terminator. Output arrives in chunks split anywhere.
 */
// oxlint-disable-next-line no-control-regex -- intentional: matches escape sequences
const PARTIAL_ESCAPE = /\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*)?$/;

/** The terminal an `open_terminal` message opens, if `message` is one. */
function openedTerminal(message: unknown): { id: string; ref: TerminalRef } | null {
  if (typeof message !== "object" || message === null) return null;
  const { type, data } = message as { type?: unknown; data?: unknown };
  if (type !== "open_terminal" || typeof data !== "object" || data === null) return null;
  const { terminalId, title, worktreePath } = data as Record<string, unknown>;
  if (typeof terminalId !== "string" || typeof title !== "string") return null;
  if (typeof worktreePath !== "string") return null;
  return { id: terminalId, ref: { worktree: worktreePath, title } };
}

/**
 * Each terminal's output, read from the app's WebSocket and told apart by task and tab title,
 * without escape sequences or whitespace (TUIs place words with cursor moves). A wait matches
 * output that arrives after it starts.
 */
export class Terminals {
  private output = new Map<string, string>();
  /** Terminal IDs by terminalKey. */
  private ids = new Map<string, string>();
  private decoders = new Map<string, TextDecoder>();
  /** The partial escape each terminal's last chunk ended with, to strip with the next chunk. */
  private partials = new Map<string, string>();
  private waiters: {
    ref: TerminalRef;
    test: (text: string) => boolean;
    from: number;
    resolve: () => void;
  }[] = [];

  constructor(page: Page) {
    page.on("websocket", (ws) => {
      ws.on("framereceived", ({ payload }) => {
        if (typeof payload === "string") return this.onMessage(payload);
        if (payload[0] !== BIN_MSG_OUTPUT) return;
        const frame = parseOutputFrame(new Uint8Array(payload));
        if (!frame) return;
        let decoder = this.decoders.get(frame.terminalId);
        if (!decoder) this.decoders.set(frame.terminalId, (decoder = new TextDecoder()));
        const raw =
          (this.partials.get(frame.terminalId) ?? "") +
          decoder.decode(frame.payload, { stream: true });
        const partial = PARTIAL_ESCAPE.exec(raw)?.[0] ?? "";
        this.partials.set(frame.terminalId, partial);
        const text = Bun.stripANSI(raw.slice(0, raw.length - partial.length)).replace(/\s/g, "");
        this.output.set(frame.terminalId, (this.output.get(frame.terminalId) ?? "") + text);
        this.settle();
      });
    });
  }

  private onMessage(payload: string): void {
    const opened = openedTerminal(JSON.parse(payload));
    if (!opened) return;
    this.ids.set(terminalKey(opened.ref), opened.id);
    this.settle();
  }

  text(ref: TerminalRef): string {
    const id = this.ids.get(terminalKey(ref));
    return id === undefined ? "" : (this.output.get(id) ?? "");
  }

  private settle(): void {
    this.waiters = this.waiters.filter((w) => {
      if (!w.test(this.text(w.ref).slice(w.from))) return true;
      w.resolve();
      return false;
    });
  }

  /** Resolve once the terminal `ref` shows `match` (text, whitespace ignored, or a pattern). */
  waitFor(
    ref: TerminalRef,
    match: string | RegExp,
    timeoutMs = 30_000,
    { fromStart = false } = {},
  ): Promise<void> {
    const test =
      typeof match === "string"
        ? (t: string) => t.includes(match.replace(/\s/g, ""))
        : (t: string) => match.test(t);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `"${ref.title}" in ${ref.worktree} never showed ${match}; last output: ${this.text(ref).slice(-300)}`,
            ),
          ),
        timeoutMs,
      );
      const from = fromStart ? 0 : this.text(ref).length;
      this.waiters.push({
        ref,
        test,
        from,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      });
      this.settle();
    });
  }
}

// ── Page input ─────────────────────────────────────────────────────────────

export const row = (page: Page, title: string) =>
  page.locator(".wt-row", { hasText: title }).first();

/** A box on the page, in CSS pixels. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The dockview group showing a tab titled `tabTitle` (the whole title, or a pattern). Only tabs
 * with a size count: other tasks' layouts stay mounted, hidden, and reuse titles.
 */
export function group(page: Page, tabTitle: string | RegExp): Locator {
  const title =
    typeof tabTitle === "string" ? new RegExp(`^\\s*${escapeRegExp(tabTitle)}\\s*$`) : tabTitle;
  return groupOf(page.locator(".dv-tab").filter({ visible: true, hasText: title }));
}

/**
 * The dockview group an element is in: its nearest, as `closest()` finds it. A task's whole
 * layout sits in a group of the window's outer layout, so the outer group holds every element too.
 */
export const groupOf = (element: Locator): Locator =>
  element.locator(
    "xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' dv-groupview ')][1]",
  );

/** The box of a locator that must be on screen. */
async function rectOf(locator: Locator, what: string): Promise<Rect> {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`${what} isn't on screen`);
  return box;
}

/** The box of the group showing the tab `tabTitle`. */
export const groupRect = (page: Page, tabTitle: string | RegExp): Promise<Rect> =>
  rectOf(group(page, tabTitle), `No group with a tab titled ${tabTitle}`);

/** The center of the panel whose tab is titled `title` (its content area, below the tab bar). */
export async function panelPoint(page: Page, tabTitle: string): Promise<{ x: number; y: number }> {
  const box = await rectOf(
    group(page, tabTitle).locator(".dv-content-container").first(),
    `No panel with a tab titled "${tabTitle}"`,
  );
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** The area the groups with these tabs cover, together: a task's layout, or part of it. */
export async function taskArea(page: Page, tabTitles: string[]): Promise<Rect> {
  const rects = await Promise.all(tabTitles.map((title) => groupRect(page, title)));
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const bottom = Math.max(...rects.map((r) => r.y + r.height));
  return { x, y, width: right - x, height: bottom - y };
}

/** Drag the divider nearest `near` (vertical dividers move to x `to`, horizontal ones to y `to`). */
export async function dragDivider(
  page: Page,
  near: { x: number; y: number },
  axis: "x" | "y",
  to: number,
): Promise<void> {
  const sash = await page.evaluate(
    ({ near, axis }) => {
      const sashes = [...document.querySelectorAll(".dv-sash.dv-enabled")].map((el) => ({
        el,
        r: el.getBoundingClientRect(),
      }));
      const along = sashes.filter(({ r }) =>
        axis === "x" ? r.height > r.width : r.width > r.height,
      );
      const contains = along.filter(({ r }) =>
        axis === "x"
          ? near.y >= r.top && near.y <= r.bottom
          : near.x >= r.left && near.x <= r.right,
      );
      const distance = (r: DOMRect) =>
        axis === "x" ? Math.abs(r.x + r.width / 2 - near.x) : Math.abs(r.y + r.height / 2 - near.y);
      const best = contains.toSorted((a, b) => distance(a.r) - distance(b.r))[0];
      if (!best) return null;
      // Grab it where it's the element under the mouse: where two dividers meet, the other one
      // can be on top and would take the drag. So walk along it from `near` until it's this one.
      const { el, r } = best;
      const across = axis === "x" ? r.x + r.width / 2 : r.y + r.height / 2;
      const [from, to] = axis === "x" ? [r.top, r.bottom] : [r.left, r.right];
      const start = axis === "x" ? near.y : near.x;
      for (let step = 0; step < (to - from) / 10; step++) {
        for (const at of [start + step * 10, start - step * 10]) {
          if (at < from + 2 || at > to - 2) continue;
          const [x, y] = axis === "x" ? [across, at] : [at, across];
          if (document.elementFromPoint(x, y) === el) return { x, y };
        }
      }
      return null;
    },
    { near, axis },
  );
  if (!sash) throw new Error(`No ${axis} divider near ${JSON.stringify(near)}`);
  await page.mouse.move(sash.x, sash.y);
  await page.mouse.down();
  await page.mouse.move(axis === "x" ? to : sash.x, axis === "y" ? to : sash.y, { steps: 8 });
  await page.mouse.up();
}

/** Click into the terminal titled `title` and type `text` without sending it. */
export async function typeInto(page: Page, title: string, text: string): Promise<void> {
  const point = await panelPoint(page, title);
  await page.mouse.click(point.x, point.y);
  await page.keyboard.type(text, { delay: 8 });
}

/**
 * Give the terminal titled `title` the keyboard focus again, without a click (which a TUI would
 * take as mouse input). Dragging a divider moves focus to the panel it ends on, and an unfocused
 * terminal draws its caret as a hollow box.
 */
export const focusTerminal = (page: Page, title: string) =>
  group(page, title).locator("textarea.xterm-helper-textarea").first().focus();

/** Park the mouse where nothing reacts to it. */
export const parkMouse = (page: Page) => page.mouse.move(720, 2);

// ── Agents ─────────────────────────────────────────────────────────────────

/** A finished agent turn: Claude Code and Codex both end one with "<Verb>ed for 12s". */
export const TURN_DONE = /\p{Lu}\p{Ll}+edfor\d+/u; // "Sautéed for 23s" counts too

/** An agent in a terminal tab of its task. */
export interface Agent extends TerminalRef {
  kind: "claude" | "codex";
  prompt: string;
  /** Typed into the input once the first answer is in, never sent */
  next: string;
}

/**
 * How agents in a shot should answer: like a real session, sized for a terminal pane. Claude Code
 * gets it as an appended system prompt, Codex as its global AGENTS.md in the demo's Codex home, so
 * nothing in the demo repositories changes.
 */
export const SCREENSHOT_BRIEF = `You are a coding agent in a real session in the Loxel IDE, and this session appears in a screenshot on Loxel's website. Answer the way an excellent senior engineer would: lead with the answer, then a few short bullets, specific to this code with file paths and line numbers; no preamble, no apology, no closing offer, and never mention screenshots or a demo. Keep every answer under 14 short lines so it fits a terminal pane. Only read: look at the files the question is about and the few they lead to (open only paths you have seen exist, so no command fails), use git diff for a branch's changes, and answer in the chat yourself, without subagents or background tasks. Never write or edit files or plans, and never run git log, git show or anything else that prints commit authors or emails.`;

/** Blanks what a screenshot must not show in an agent's screen (redact.py). */
const REDACT = resolve(import.meta.dirname, "redact.py");

export function agentCommand(s: Shot, { kind, prompt }: Agent): string[] {
  if (kind === "codex") {
    return ["env", `CODEX_HOME=${s.codexHome}`, "python3", "-I", REDACT, "codex", prompt];
  }
  // One shell line, kept short: a terminal's command is typed in before its shell is ready, and
  // macOS drops the Enter of a typed-ahead line past 1024 bytes. So the brief comes from its file
  // (the Codex home's AGENTS.md is the same brief) rather than the command line.
  return [
    [
      // A clean screen: no direnv notice or typed command above the agent.
      "clear &&",
      `python3 -I ${shellQuote(REDACT)}`,
      // Its commands in bash: zsh fails a whole command on an unmatched glob ("no matches
      // found: --include=*.ts"), where bash passes the word through as grep expects.
      "env SHELL=/bin/bash claude --permission-mode plan",
      // No away summary: a hidden window always looks like the user stepped away.
      `--settings ${shellQuote(JSON.stringify({ awaySummaryEnabled: false }))}`,
      `--append-system-prompt "$(cat ${shellQuote(resolve(s.codexHome, "AGENTS.md"))})"`,
      shellQuote(prompt),
    ].join(" "),
  ];
}

/** Answer a demo worktree's "trust this folder" prompt if the agent shows one. */
export async function acceptTrust(s: Shot, agent: Agent): Promise<void> {
  const asked = agent.kind === "claude" ? "I trust this folder" : "Trust and continue";
  // Signs it's past any trust prompt: Claude Code's header comes after it; Codex draws its header
  // first, so wait for it to be at work on the prompt instead.
  const started = s.terminals.waitFor(
    agent,
    agent.kind === "claude" ? "Claude Code v" : "esc to interrupt",
    AGENT_MS,
  );
  // Raced below and then left behind: it may still time out later, which is no failure.
  started.catch(() => {});
  const trust = s.terminals.waitFor(agent, asked).then(
    () => true,
    () => false,
  );
  if (!(await Promise.race([started.then(() => false), trust]))) return;
  const point = await panelPoint(s.page, agent.title);
  await s.page.mouse.click(point.x, point.y);
  if (agent.kind === "claude") {
    await s.page.keyboard.press("ArrowDown");
    await s.terminals.waitFor(agent, "❯ Yes, I trust this folder").catch(() => {});
  }
  await s.page.keyboard.press("Enter");
}

/** Wait for an agent's first answer, then type its follow-up without sending it. */
export async function finishAgent(s: Shot, agent: Agent): Promise<void> {
  // From the start: a quick agent can be done before the shot gets here.
  await s.terminals.waitFor(agent, TURN_DONE, AGENT_MS, { fromStart: true });
  await typeInto(s.page, agent.title, agent.next);
}

// ── Retrying ───────────────────────────────────────────────────────────────

/** Retry `action` until `done` holds: for input sent while the page may still be settling. */
export async function until(
  done: () => Promise<boolean>,
  action: () => Promise<void>,
  what: string,
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    await action();
    for (let check = 0; check < 10; check++) {
      if (await done()) return;
      await Bun.sleep(100);
    }
  }
  throw new Error(`Couldn't ${what}`);
}

/**
 * Scroll the editor in the panel with tab `tabTitle` so `line` is its first line, flush with the
 * top. Wheel input can't do it: Monaco scrolls a fixed 50px per wheel event, and its scroll-a-line
 * keys are macOS's window tiling keys. So this finds the editor instance through React (the ref
 * that holds it) and sets its scroll position.
 */
export async function scrollEditorTo(page: Page, tabTitle: string, line: number): Promise<void> {
  const scrolled = await group(page, tabTitle)
    .locator(".monaco-editor")
    .first()
    .evaluate((dom, line) => {
      interface Editor {
        getDomNode(): Element | null;
        getTopForLineNumber(line: number): number;
        setScrollTop(top: number): void;
      }
      const asEditor = (value: unknown): Editor | null => {
        const v = value as Partial<Editor> | null;
        return typeof v?.setScrollTop === "function" && v.getDomNode?.() === dom
          ? (v as Editor)
          : null;
      };
      for (let node: Element | null = dom; node; node = node.parentElement) {
        const key = Object.keys(node).find((k) => k.startsWith("__reactFiber$"));
        type Fiber = { return: Fiber | null; memoizedState: unknown };
        type Hook = { memoizedState: unknown; next: Hook | null };
        let fiber = key ? (node as unknown as Record<string, Fiber>)[key] : null;
        for (; fiber; fiber = fiber.return) {
          let hook = fiber.memoizedState as Hook | null;
          for (; hook && typeof hook === "object" && "next" in hook; hook = hook.next) {
            const held = hook.memoizedState as { current?: unknown } | null;
            const editor = asEditor(held?.current) ?? asEditor(held);
            if (!editor) continue;
            editor.setScrollTop(editor.getTopForLineNumber(line));
            return true;
          }
        }
      }
      return false;
    }, line);
  if (!scrolled) throw new Error(`No editor found in the panel "${tabTitle}"`);
  // Monaco shows its scrollbars on a scroll and fades them out a moment later.
  await page.waitForFunction(() => !document.querySelector(".monaco-editor .scrollbar.visible"));
}

// ── Side panels and diffs ──────────────────────────────────────────────────

/** Fold the worktree sidebar away if it's expanded: it steps aside while a side panel is open. */
export async function collapseSidebar(page: Page): Promise<void> {
  const collapse = page.getByTitle("Collapse sidebar");
  if (!(await collapse.isVisible())) return;
  await collapse.click();
  await page.getByTitle("Expand sidebar").waitFor();
  // The window's content slides left as the sidebar folds: wait until it's still, so what a shot
  // measures next (and drags to) is where it stays.
  const left = async () => (await page.locator(".dv-dockview").first().boundingBox())?.x ?? 0;
  for (let last = -1, now = await left(); now !== last; now = await left()) {
    last = now;
    await page.waitForTimeout(150);
  }
}

/** Open the Changes panel and switch it to All branch changes, so it lists the PR's files. */
export async function openBranchChanges(page: Page): Promise<Locator> {
  const changes = page.locator("h2", { hasText: /^Changes/ });
  await until(
    () => changes.isVisible(),
    () => page.keyboard.press("Meta+Shift+C"),
    "open Changes",
  );
  const allBranch = page.getByRole("menuitemcheckbox", { name: /All branch changes/ });
  await until(
    () => allBranch.isVisible(),
    () => changes.locator("..").getByRole("button").last().click(),
    "open the commit picker",
  );
  await allBranch.click();
  await page.keyboard.press("Escape");
  return changes;
}

/**
 * Where the branch side's line `line` is in the split diff: its line-number cell (the rightmost
 * cell numbered `line`), and the top of the code area it scrolls in. Null when it isn't rendered.
 */
export function diffLine(
  page: Page,
  line: number,
): Promise<{ cell: Rect; areaTop: number } | null> {
  return page.evaluate((n) => {
    const cell = [...document.querySelectorAll("div.font-mono.select-none")]
      .filter((d) => d.textContent?.trim() === String(n) && d.getBoundingClientRect().height > 0)
      .toSorted((a, b) => b.getBoundingClientRect().x - a.getBoundingClientRect().x)[0];
    const area = cell?.closest(".overflow-hidden")?.getBoundingClientRect();
    if (!cell || !area) return null;
    const { x, y, width, height } = cell.getBoundingClientRect();
    return { cell: { x, y, width, height }, areaTop: area.top };
  }, line);
}

/**
 * Clear the Logs tool's unread dot, if it shows one, by opening and closing it, as a person who
 * looked would. Only then: the toggle swaps out whatever shares Logs' zone. Focus goes back where
 * it was, so a terminal the shot typed into keeps its caret. Returns whether it toggled, so a shot
 * can put back what shared the zone.
 */
export async function clearLogsDot(page: Page): Promise<boolean> {
  const dot = page.locator('div.relative:has(> button[title="Logs"]) > span.bg-destructive');
  if (!(await dot.isVisible())) return false;
  const focused = await page.evaluateHandle(() => document.activeElement);
  await page.keyboard.press("Control+Shift+L");
  await page.keyboard.press("Control+Shift+L");
  await focused.evaluate((el) => {
    if (el instanceof HTMLElement && el !== document.body) el.focus();
  });
  await focused.dispose();
  return true;
}
