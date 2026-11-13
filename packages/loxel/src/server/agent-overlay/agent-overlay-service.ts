/**
 * The agent overlay's server side: receives Claude Code's hooks from the terminals, keeps one
 * {@link AgentSession} per terminal, follows its transcript, tells every window about the session
 * and its subscribers about the transcript, and carries out the renderer's actions by typing into
 * the terminal (claude-driver.ts). See docs/AGENT_OVERLAY.md.
 */
import { join } from "node:path";

import type {
  AgentAction,
  AgentActionResult,
  AgentOverlayServerMessage,
  AgentSessionSummary,
  AgentTranscriptItem,
} from "@/api/agent-overlay-model";
import { AgentActionRequestSchema } from "@/api/agent-overlay-model";
import type { ChildLogger } from "@/api/log-entry-model";
import type { TerminalScreen } from "@/terminal-host";

import type { HookPayload } from "./agent-session";
import { AgentSession, HookPayloadSchema } from "./agent-session";
import { ClaudeCatalog } from "./claude-catalog";
import type { TerminalIO } from "./claude-driver";
import {
  FallbackError,
  answerPermission,
  answerPlan,
  answerQuestions,
  interrupt,
  setPermissionMode,
  submitPrompt,
} from "./claude-driver";
import {
  AgentHookAuth,
  HOOK_PATH,
  TERMINAL_HEADER,
  TOKEN_HEADER,
  claudeLaunchCommand,
  writeLaunchSettings,
} from "./claude-hooks";
import { recognizeDialog } from "./claude-screen";
import type { ClaudeDialogKind } from "./claude-screen";
import { TranscriptTailer } from "./claude-transcript";

/** The terminals the overlay reads and types into. */
export interface OverlayTerminals {
  has(id: string): boolean;
  screen(id: string): Promise<TerminalScreen | null>;
  write(id: string, data: Uint8Array): void;
}

/** A connection that receives overlay messages. */
export interface OverlaySubscriber {
  send(data: string): void;
}

export interface AgentOverlayOptions {
  /** Where the hook key and the launch settings live. */
  dir: string;
  terminals: OverlayTerminals;
  broadcastAll: (message: AgentOverlayServerMessage) => void;
  spawnEnv: () => Record<string, string | undefined>;
  log: ChildLogger;
  /** How often the screen is checked while Claude waits on a dialog. */
  screenWatchMs?: number;
}

const DIALOG_FOR: Record<string, readonly ClaudeDialogKind[]> = {
  permission: ["permission"],
  plan: ["plan"],
  question: ["question", "question-review"],
};
/** Checks in a row without the dialog before an interaction counts as answered in the terminal. */
const MISSES_BEFORE_DISMISS = 3;

interface Tracked {
  session: AgentSession;
  tailer: TranscriptTailer | null;
  /** The terminal's subscribers, shared with `subscribers` by terminal ID. */
  subscribers: Set<OverlaySubscriber>;
  watch: ReturnType<typeof setInterval> | null;
  /** The interaction the running watch is for. */
  watching: string | null;
  /** A screen read in flight, so a slow read does not overlap the next tick. */
  checking: boolean;
  /** The terminal ended: late callbacks and queued actions must do nothing. */
  closed: boolean;
  misses: number;
  /** The pending interaction's dialog has been recognized on screen. */
  seen: boolean;
  /** What the windows were last told, to skip repeats. */
  published: string;
  /** Actions run one at a time per terminal, in order. */
  queue: Promise<unknown>;
}

const encoder = new TextEncoder();

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

export class AgentOverlayService {
  readonly auth: AgentHookAuth;
  private readonly sessions = new Map<string, Tracked>();
  /**
   * Subscribers by terminal, kept apart from the sessions: a renderer subscribes as its overlay
   * mounts, which after a server restart can be before the session's next hook recreates it.
   */
  private readonly subscribers = new Map<string, Set<OverlaySubscriber>>();
  private readonly catalog: ClaudeCatalog;
  private readonly launchSettings: string;

  constructor(private readonly options: AgentOverlayOptions) {
    this.auth = new AgentHookAuth(options.dir);
    this.launchSettings = writeLaunchSettings(options.dir);
    this.catalog = new ClaudeCatalog(options.spawnEnv);
  }

  /** The variables a terminal's shell gets so hooks from it reach this service. */
  terminalEnv(terminalId: string): Record<string, string> {
    return { LOXEL_TERMINAL_ID: terminalId, LOXEL_AGENT_TOKEN: this.auth.token(terminalId) };
  }

  syncMessage(): AgentOverlayServerMessage {
    return {
      type: "agent_sessions_sync",
      sessions: [...this.sessions.values()].map(({ session }) => session.summary()),
    };
  }

  /** Routes under `/api/agent-overlay/`; null for any other path. */
  async handle(req: Request, url: URL): Promise<Response | null> {
    const route = `${req.method} ${url.pathname}`;
    switch (route) {
      case `POST ${HOOK_PATH}`:
        return this.receiveHook(req);
      case "POST /api/agent-overlay/action":
        return this.receiveAction(req);
      case "GET /api/agent-overlay/catalog":
        return this.catalogFor(url.searchParams.get("terminalId") ?? "");
      case "GET /api/agent-overlay/launch":
        return json({ command: claudeLaunchCommand(this.launchSettings) });
      default:
        return url.pathname.startsWith("/api/agent-overlay/")
          ? json({ error: "Not found" }, 404)
          : null;
    }
  }

  private async receiveHook(req: Request): Promise<Response> {
    const terminalId = req.headers.get(TERMINAL_HEADER) ?? "";
    const token = req.headers.get(TOKEN_HEADER) ?? "";
    if (!terminalId || !this.auth.verify(terminalId, token))
      return json({ error: "Forbidden" }, 403);
    // A hook from a shell whose terminal is gone (or not this server's) has nothing to show in.
    if (!this.options.terminals.has(terminalId)) return json({});
    const payload = HookPayloadSchema.safeParse(await req.json().catch(() => null));
    if (!payload.success) return json({ error: "Not a hook payload" }, 400);
    this.applyHook(terminalId, payload.data);
    return json({});
  }

  private applyHook(terminalId: string, payload: HookPayload): void {
    let tracked = this.sessions.get(terminalId);
    let follow: string | null = null;
    if (!tracked) {
      tracked = {
        session: new AgentSession(terminalId, payload),
        tailer: null,
        subscribers: this.subscriberSet(terminalId),
        watch: null,
        watching: null,
        checking: false,
        closed: false,
        misses: 0,
        seen: false,
        published: "",
        queue: Promise.resolve(),
      };
      this.sessions.set(terminalId, tracked);
      follow = payload.transcript_path;
    }
    const change = tracked.session.applyHook(payload);
    follow = change.transcriptPath ?? follow;
    if (follow) this.follow(tracked, follow);
    if (change.summary) this.publish(tracked);
    this.updateScreenWatch(tracked);
  }

  /** Follows the session's transcript file, replacing the transcript subscribers see. */
  private follow(tracked: Tracked, path: string): void {
    tracked.tailer?.stop();
    const { session } = tracked;
    // A different file is a different conversation (`/clear`, a resumed session): start over.
    if (session.resetTranscript()) this.sendTranscript(tracked, true, []);
    tracked.tailer = new TranscriptTailer(path, (records, reset) => {
      if (reset) session.resetTranscript();
      const items = session.applyTranscript(records);
      if (reset) this.sendTranscript(tracked, true, session.transcriptItems());
      else if (items.length > 0) this.sendTranscript(tracked, false, items);
      // The title and the permission mode can come from the transcript.
      this.publish(tracked);
    });
    tracked.tailer.start();
  }

  private sendTranscript(tracked: Tracked, reset: boolean, items: AgentTranscriptItem[]): void {
    if (tracked.subscribers.size === 0) return;
    const message: AgentOverlayServerMessage = {
      type: "agent_transcript",
      terminalId: tracked.session.terminalId,
      reset,
      items,
    };
    const data = JSON.stringify(message);
    for (const subscriber of tracked.subscribers) subscriber.send(data);
  }

  /** Tells every window about the session, unless nothing they see changed. */
  private publish(tracked: Tracked): void {
    if (tracked.closed) return;
    const { updatedAt: _updatedAt, ...shown } = tracked.session.summary();
    const key = JSON.stringify(shown);
    if (key === tracked.published) return;
    tracked.published = key;
    this.options.broadcastAll({
      type: "agent_session",
      terminalId: tracked.session.terminalId,
      session: tracked.session.summary(),
    });
  }

  /**
   * While Claude waits on a dialog the overlay can answer, reads the screen to show the choices as
   * the terminal words them, and to notice the dialog was answered in the terminal (no hook says so).
   */
  private updateScreenWatch(tracked: Tracked): void {
    const interaction = tracked.session.pendingInteraction;
    const kinds = interaction ? DIALOG_FOR[interaction.kind] : undefined;
    // Already watching for this interaction; one that replaced it gets a fresh watch.
    if (kinds && interaction && tracked.watching === interaction.id && tracked.watch) return;
    if (tracked.watch) clearInterval(tracked.watch);
    tracked.watch = null;
    tracked.watching = null;
    tracked.misses = 0;
    tracked.seen = false;
    if (!kinds || !interaction || tracked.closed) return;
    tracked.watching = interaction.id;
    const check = async (): Promise<void> => {
      if (tracked.checking || tracked.closed) return;
      tracked.checking = true;
      let screen;
      try {
        screen = await this.options.terminals.screen(tracked.session.terminalId);
      } finally {
        tracked.checking = false;
      }
      if (!screen || tracked.closed || tracked.session.pendingInteraction !== interaction) return;
      const dialog = recognizeDialog(screen.lines);
      if (dialog && kinds.includes(dialog.kind)) {
        tracked.misses = 0;
        tracked.seen = true;
        const options = dialog.options.map(({ number, label }) => ({ number, label }));
        if (tracked.session.setDialogOptions(options)) this.publish(tracked);
        return;
      }
      tracked.misses++;
      if (tracked.session.setDialogOptions(null)) this.publish(tracked);
      // Only a dialog seen on screen and then gone was answered in the terminal; one never
      // recognized (a layout this version does not know) is left to the hooks to clear.
      if (!tracked.seen) return;
      if (tracked.misses >= MISSES_BEFORE_DISMISS && tracked.session.dismissInteraction()) {
        this.publish(tracked);
        this.updateScreenWatch(tracked);
      }
    };
    tracked.watch = setInterval(() => void check(), this.options.screenWatchMs ?? 750);
    void check();
  }

  private subscriberSet(terminalId: string): Set<OverlaySubscriber> {
    let set = this.subscribers.get(terminalId);
    if (!set) this.subscribers.set(terminalId, (set = new Set()));
    return set;
  }

  /** Follows a terminal's transcript; before its session exists, from the session's first hook. */
  subscribe(subscriber: OverlaySubscriber, terminalId: string): void {
    this.subscriberSet(terminalId).add(subscriber);
    const tracked = this.sessions.get(terminalId);
    if (!tracked) return;
    const message: AgentOverlayServerMessage = {
      type: "agent_transcript",
      terminalId,
      reset: true,
      items: tracked.session.transcriptItems(),
    };
    subscriber.send(JSON.stringify(message));
  }

  unsubscribe(subscriber: OverlaySubscriber, terminalId: string): void {
    const set = this.subscribers.get(terminalId);
    set?.delete(subscriber);
    if (set?.size === 0 && !this.sessions.has(terminalId)) this.subscribers.delete(terminalId);
  }

  dropSubscriber(subscriber: OverlaySubscriber): void {
    for (const [terminalId, set] of this.subscribers) {
      set.delete(subscriber);
      if (set.size === 0 && !this.sessions.has(terminalId)) this.subscribers.delete(terminalId);
    }
  }

  /** The terminal ended: its session goes with it. */
  removeTerminal(terminalId: string): void {
    const tracked = this.sessions.get(terminalId);
    if (!tracked) return;
    tracked.closed = true;
    tracked.tailer?.stop();
    if (tracked.watch) clearInterval(tracked.watch);
    this.sessions.delete(terminalId);
    this.subscribers.delete(terminalId);
    this.options.broadcastAll({ type: "agent_session", terminalId, session: null });
  }

  dispose(): void {
    for (const id of [...this.sessions.keys()]) this.removeTerminal(id);
  }

  summary(terminalId: string): AgentSessionSummary | null {
    return this.sessions.get(terminalId)?.session.summary() ?? null;
  }

  private async catalogFor(terminalId: string): Promise<Response> {
    const tracked = this.sessions.get(terminalId);
    if (!tracked) return json({ error: "No agent session in this terminal" }, 404);
    try {
      // Not the session's directory: print mode skips the workspace trust prompt, so a cloned
      // repository's own settings (hooks, MCP servers) would run. User-level commands, skills and
      // models are what this lists; project ones show only in the terminal's own `/` menu.
      return json(await this.catalog.get(tracked.session.summary().homeDir));
    } catch (err) {
      this.options.log.warn("Could not list Claude Code's commands", { error: err });
      return json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  }

  private async receiveAction(req: Request): Promise<Response> {
    const parsed = AgentActionRequestSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return json({ ok: false, error: "Invalid action", fallback: false }, 400);
    return json(await this.perform(parsed.data.terminalId, parsed.data.action));
  }

  /** Runs an action in the terminal, after any still running there. */
  perform(terminalId: string, action: AgentAction): Promise<AgentActionResult> {
    const tracked = this.sessions.get(terminalId);
    if (!tracked) {
      return Promise.resolve({
        ok: false,
        error: "No agent session in this terminal",
        fallback: true,
      });
    }
    const io: TerminalIO = {
      screen: async () => (await this.options.terminals.screen(terminalId))?.lines ?? null,
      write: (data) => this.options.terminals.write(terminalId, encoder.encode(data)),
    };
    const run = tracked.queue.then(() => {
      if (tracked.closed) throw new FallbackError("The terminal has ended");
      return this.run(tracked, io, action);
    });
    tracked.queue = run.catch(() => undefined);
    return run.then(
      (): AgentActionResult => ({ ok: true }),
      (err: unknown): AgentActionResult => {
        if (err instanceof FallbackError) return { ok: false, error: err.message, fallback: true };
        this.options.log.warn("Agent overlay action failed", {
          terminalId,
          action: action.type,
          error: err,
        });
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          fallback: false,
        };
      },
    );
  }

  private async run(tracked: Tracked, io: TerminalIO, action: AgentAction): Promise<void> {
    const interaction = tracked.session.pendingInteraction;
    // An answer is for the interaction the user saw. Another may have replaced it while the
    // answer waited (a parallel tool call, a queue behind an earlier action): never approve that.
    if ("interactionId" in action && interaction?.id !== action.interactionId) {
      throw new FallbackError("Claude is now asking something else; check it before answering");
    }
    switch (action.type) {
      case "prompt":
        return submitPrompt(io, action.text);
      case "interrupt":
        interrupt(io);
        tracked.session.markInterrupted();
        this.publish(tracked);
        return;
      case "permission":
        await answerPermission(io, action.decision, action.feedback);
        // A refusal ends the turn; feedback, if any, starts the next one with its own hooks.
        if (action.decision === "deny" && !action.feedback?.trim()) {
          tracked.session.markInterrupted();
          this.publish(tracked);
        }
        return;
      case "question":
        if (interaction?.kind !== "question")
          throw new FallbackError("Claude is not asking a question");
        return answerQuestions(io, interaction.questions, action.answers);
      case "plan":
        return answerPlan(io, action.decision, action.feedback);
      case "mode":
        await setPermissionMode(io, action.mode);
        tracked.session.setPermissionMode(action.mode);
        this.publish(tracked);
        return;
      case "model":
        return submitPrompt(io, `/model ${action.model}`);
      case "effort":
        return submitPrompt(io, `/effort ${action.effort}`);
      default: {
        const unknown: never = action;
        throw new Error(`Unknown action ${JSON.stringify(unknown)}`);
      }
    }
  }
}

/** The overlay's directory under the state directory. */
export function agentOverlayDir(stateDir: string): string {
  return join(stateDir, "agent-overlay");
}
