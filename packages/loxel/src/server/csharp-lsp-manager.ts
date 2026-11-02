import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { ServerWebSocket, Subprocess } from "bun";

import {
  type CSharpBlock,
  type CSharpLspState,
  type CSharpProjects,
  type CSharpRestoreState,
  csharpToolchain,
} from "@/api/csharp-env-model";
import { LSP_REPLACED_CLOSE_CODE, LSP_RESTART_CLOSE_CODE } from "@/api/ws-protocol";
import { isRecord } from "@/lib/is-record";

import {
  ASSETS_FILE,
  automaticCSharpSolution,
  csharpRestoreState,
  csharpSelectableSolutions,
  discoverCSharpProjects,
  dotnetGlobalToolsDir,
  fileStamp,
  readSmallText,
  dotnetRuntimes,
  dotnetSdks,
  dotnetSdkVersion,
  dotnetSpawnEnv,
  inspectGlobalJson,
  MIN_RUNTIME_MAJOR,
  prepareDotnet,
  readDotnetToolManifests,
  refreshCSharpRestore,
  resolveDotnet,
  resolveGlobalDotnetTool,
  runDotnet,
  subscribeCSharpRestore,
  toolClaimsCommand,
} from "./csharp-env";
import { announceCSharpStatus, publishCSharpLspState } from "./csharp-lsp-state";
import { getCSharpSolution, onCSharpSolutionChange } from "./csharp-solution-store";
import { mapWithConcurrency } from "./git-commands";
import { isRepoTrusted, onRepoTrustChange } from "./repo-trust";
import { buildSpawnEnv, onLoginShellEnvChange, refreshLoginShellEnv } from "./shell-env";
import {
  type SpawnOptions,
  WorktreeLspManager,
  type WtLspContext,
  type WtLspSession,
} from "./stdio-lsp-manager";

const CSHARP_LS = "csharp-ls";
const DOTNET = "dotnet";
const NETCORE_APP = "Microsoft.NETCore.App";
/** First release with the `csharp.analyzersEnabled` setting that diagnostics rely on. */
export const MIN_CSHARP_LS_VERSION = "0.24.0";
/** A restore writes one assets file per project; a restart waits for this much quiet. */
const RESTORE_SETTLE_MS = 3_000;
const GATE_TIMEOUT_MS = 45_000;
/** Restarts for a changed restored state per worktree in {@link RESTORE_RESTART_WINDOW_MS}. */
const MAX_RESTORE_RESTARTS = 3;
const RESTORE_RESTART_WINDOW_MS = 5 * 60_000;
/** How often a connection waiting for a toolchain looks for it, since nothing announces an install. */
const TOOLCHAIN_RECHECK_MS = 10_000;
/** Every this many rechecks, the login-shell environment is captured again. */
const LOGIN_SHELL_REFRESH_TICKS = 6;
/** The first three parts: older releases print four, which semver comparison rejects. */
const VERSION_RE = /(\d+\.\d+\.\d+)/;
/** LSP `MessageType.Warning`. */
const MESSAGE_TYPE_WARNING = 2;
const CHECK_CONCURRENCY = 6;
/** `Sdk="..."` on `Project` or `Import`, or `<Sdk Name="..." />`. */
const PROJECT_SDK_RE = /\bSdk\s*=\s*"([^"]*)"|<Sdk\s+Name\s*=\s*"([^"]*)"/g;
/** The SDKs that come with .NET, as opposed to a package. */
const BUNDLED_SDK_RE = /^Microsoft\.NET\.Sdk(?:\.[\w.]+)?$/i;
/** A project path in a `.sln` (`"src\\App\\App.csproj"`) or `.slnx` (`Path="src/App/App.csproj"`). */
const SOLUTION_PROJECT_RE = /"([^"]+\.csproj)"/g;
const SOLUTION_FILTER_EXTENSION = ".slnf";
const MAX_NAMED_PROJECTS = 3;
/** A load reports its failures one by one; they are told together after this much quiet. */
const LOAD_FAILURE_SETTLE_MS = 2_000;
const LOAD_FAILURE_RE = /\[Failure\][^']*'([^']+\.csproj)'(?: with message: (.{1,200}))?/;
/** csharp-ls tells the user this itself, and goes on running with nothing loaded. */
const SOLUTION_LOAD_FAILURE = "could not be loaded";
const MAX_FAILURE_LENGTH = 400;
/** Changes to these can change what the gate says. */
const PROJECT_FILE = /(?:\.csproj|\.sln|\.slnx|\.slnf|[\\/]global\.json|[\\/]dotnet-tools\.json)$/;

/** Answered for the `csharp` section of `workspace/configuration`. */
export const CSHARP_LS_SETTINGS = { analyzersEnabled: true };

/**
 * Set in the server's environment: its MSBuild work runs inside it, with no node or compiler server
 * left behind when it stops.
 */
const CSHARP_LS_ENV = {
  MSBUILDDISABLENODEREUSE: "1",
  DOTNET_CLI_USE_MSBUILD_SERVER: "0",
  UseSharedCompilation: "false",
  // A project naming an MSBuild SDK from NuGet would otherwise have it downloaded at load.
  MSBUILDDISABLENUGETSDKRESOLVER: "1",
};

const INSTALL_COMMAND = `dotnet tool install --global ${CSHARP_LS}`;
const UPDATE_COMMAND = `dotnet tool update --global ${CSHARP_LS}`;

const NO_FEATURES = "Until then, C# files get syntax highlighting only.";
const TRUST_RESTRICTION = "C# projects don't load, so C# files get syntax highlighting only.";

/** What the user is told while nothing can load, and whether a recheck could find the way out. */
interface GateNotice {
  message: string;
  /** Nothing the worktree's files would announce: looked for on a timer. */
  toolchain: boolean;
  block: CSharpBlock;
}

function toolchainNotice(block: CSharpBlock, message: string): GateNotice {
  return { message: `${message} ${NO_FEATURES}`, toolchain: true, block };
}

/** How to run csharp-ls for a worktree. */
interface CSharpLaunch {
  command: string;
  /** What comes before csharp-ls's own arguments. */
  prefixArgs: readonly string[];
  args: readonly string[];
  env: Record<string, string | undefined>;
  /** What the user should know about what it will load. */
  notices: readonly string[];
  /** The `--solution` it gets; null when it loads the projects. */
  target: string | null;
  /** The projects that load. */
  projects: readonly string[];
  sdkVersion: string;
}

type ToolLaunch = Pick<CSharpLaunch, "command" | "prefixArgs" | "env" | "sdkVersion">;

interface ClosedGate {
  open: false;
  notice: GateNotice | null;
  /** What the status shows; null when the checks could not finish. */
  state: CSharpLspState | null;
  /** The checks could not finish, which says nothing about the state. */
  retry?: boolean;
}

type CSharpGate = { open: true; launch: CSharpLaunch } | ClosedGate;

const COULD_NOT_TELL: ClosedGate = { open: false, notice: null, state: null, retry: true };
const NO_PROJECT: ClosedGate = { open: false, notice: null, state: { kind: "no-project" } };
const UNTRUSTED: ClosedGate = {
  open: false,
  notice: null,
  state: {
    kind: "blocked",
    block: "untrusted",
    message: `This repository is not trusted. ${TRUST_RESTRICTION}`,
  },
};

function closedBy(notice: GateNotice): ClosedGate {
  const { block, message } = notice;
  return { open: false, notice, state: { kind: "blocked", block, message } };
}

/**
 * A connection with no server behind it. It answers the LSP handshake so the client stays
 * connected with no features rather than stopped, and a change that opens the gate restarts the
 * client ({@link LSP_RESTART_CLOSE_CODE}), which connects again and gets a server.
 */
interface HeldConnection {
  ws: ServerWebSocket<unknown>;
  context: WtLspContext;
  /** Until the first decision: what the client sent, kept for the server or answered here. */
  frames: string[] | null;
  deciding: boolean;
  decideAgain: boolean;
  initialized: boolean;
  notice: GateNotice | null;
  sentNotice: string | null;
  recheck: ReturnType<typeof setInterval> | null;
  /** What the last recheck saw of the toolchain, see {@link toolchainStamp}. */
  toolchainStamp: string | null;
  /** The last decision could not finish. */
  retrying: boolean;
  /** Each runs at release. */
  stops: (() => void)[];
}

/**
 * csharp-ls, the user's own install, one per worktree. Loading a project runs the repository's code
 * (MSBuild evaluates it), and a project with nothing restored gives only errors, so no process runs
 * unless the repository is trusted, a project is restored and csharp-ls and .NET are there
 * ({@link gate}). Otherwise the connection is held without a process, and comes back by itself when
 * the state changes: trust, a `dotnet restore`, a new project, an install.
 *
 * Loxel never installs or restores anything: the notices say what to run in a terminal.
 */
export class CSharpLspManager extends WorktreeLspManager {
  protected override readonly repoTrustRestriction = TRUST_RESTRICTION;
  protected override readonly forwardWatchedFiles = true;
  /** For {@link restartAfterRestore}: csharp-ls does not read these again by itself. */
  protected override readonly watchedIgnoredGlobs = ["**/obj/**/project.assets.json"];

  private readonly held = new Map<ServerWebSocket<unknown>, HeldConnection>();
  /** The launch the gate chose, from opening until the server is spawned. */
  private readonly launches = new Map<string, CSharpLaunch>();
  /** Stops watching a running server's restored state. */
  private readonly restoreStops = new Map<WtLspSession, () => void>();
  /** What a running server's connection is told once initialized, from the gate's decision. */
  private readonly launchNotices = new Map<WtLspSession, readonly string[]>();
  /** What a running server was told to load, to tell whether a choice changes that. */
  private readonly launchTargets = new Map<WtLspSession, string | null>();
  /** Projects a running server's load failed on, waiting to be told together. */
  private readonly loadFailures = new Map<
    WtLspSession,
    { projects: Set<string>; reason: string | null; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly restoreRestartTimes = new Map<string, number[]>();
  /** A running server's restart waiting for its restore to finish. */
  private readonly restoreRestarts = new Map<WtLspSession, ReturnType<typeof setTimeout>>();
  private unsubscribeTrust: (() => void) | null = null;
  private unsubscribeLoginShell: (() => void) | null = null;
  private unsubscribeSolution: (() => void) | null = null;

  constructor(
    private readonly recheckMs = TOOLCHAIN_RECHECK_MS,
    private readonly restoreSettleMs = RESTORE_SETTLE_MS,
    private readonly loadFailureSettleMs = LOAD_FAILURE_SETTLE_MS,
    private readonly gateTimeoutMs = GATE_TIMEOUT_MS,
  ) {
    super("csharp-lsp");
  }

  // -------------------------------------------------------------------------
  // The gate, ahead of the base's session

  /** Everything starts here: the base's `createSession` comes through with trust decided. */
  protected override startSession(ws: ServerWebSocket<unknown>, context: WtLspContext): void {
    this.detach(ws);
    this.replaceOthersFor(context.wtPath);
    this.unsubscribeTrust ??= onRepoTrustChange(() => {
      for (const held of [...this.held.values()]) void this.decide(held);
    });
    this.unsubscribeLoginShell ??= onLoginShellEnvChange(() => {
      for (const held of [...this.held.values()]) void this.decide(held);
    });
    this.unsubscribeSolution ??= onCSharpSolutionChange((wtPath) => {
      for (const held of [...this.held.values()]) {
        if (held.context.wtPath === wtPath) void this.decide(held);
      }
      void this.restartForTarget(wtPath);
    });
    const held: HeldConnection = {
      ws,
      context,
      frames: [],
      deciding: false,
      decideAgain: false,
      initialized: false,
      notice: null,
      sentNotice: null,
      recheck: null,
      toolchainStamp: null,
      retrying: false,
      stops: [],
    };
    this.held.set(ws, held);
    void this.decide(held);
  }

  override handleMessage(ws: ServerWebSocket<unknown>, data: string): void {
    const held = this.held.get(ws);
    if (!held) {
      super.handleMessage(ws, data);
    } else if (held.frames) {
      held.frames.push(data);
    } else {
      this.answerHeld(held, data);
    }
  }

  override detach(ws: ServerWebSocket<unknown>): void {
    this.releaseHeld(ws);
    super.detach(ws);
  }

  override async destroy(): Promise<void> {
    this.unsubscribeTrust?.();
    this.unsubscribeTrust = null;
    this.unsubscribeLoginShell?.();
    this.unsubscribeLoginShell = null;
    this.unsubscribeSolution?.();
    this.unsubscribeSolution = null;
    for (const ws of [...this.held.keys()]) this.releaseHeld(ws);
    await super.destroy();
  }

  /** A project or SDK file changed: what a held connection waits for may be there now. */
  override notifyWatchedFilesChanged(wtPath: string, paths: readonly string[]): void {
    super.notifyWatchedFilesChanged(wtPath, paths);
    if (paths.some((file) => path.basename(file) === ASSETS_FILE)) {
      for (const session of this.sessions.values()) {
        if (session.wtPath === wtPath) this.restartAfterRestore(session);
      }
    }
    if (!paths.some((file) => PROJECT_FILE.test(file))) return;
    refreshCSharpRestore(wtPath);
    // Whether a chosen solution is there, or an untrusted repository has a project, may be different.
    announceCSharpStatus(wtPath);
    if (getCSharpSolution(wtPath) !== null) void this.restartForTarget(wtPath);
    for (const held of [...this.held.values()]) {
      if (held.context.wtPath === wtPath) void this.decide(held);
    }
  }

  /**
   * The choice changed, or its file came or went. csharp-ls loads one thing for its whole life, so a
   * server loading something else starts again, and the reconnect goes through the gate.
   */
  private async restartForTarget(wtPath: string): Promise<void> {
    const running = [...this.sessions.values()].filter((session) => session.wtPath === wtPath);
    if (running.length === 0) return;
    const target = loadTarget(await discoverCSharpProjects(wtPath), getCSharpSolution(wtPath));
    for (const session of running) {
      if (!this.isSessionLive(session) || this.launchTargets.get(session) === target) continue;
      this.log.info("Restarting csharp-ls: it should load something else", { wtPath, target });
      const { ws } = session;
      this.detach(ws);
      ws.close(LSP_RESTART_CLOSE_CODE, "The C# solution changed; reconnect");
    }
  }

  /** One decision at a time, and a change meanwhile decides again with the latest state. */
  private async decide(held: HeldConnection): Promise<void> {
    if (held.deciding) {
      held.decideAgain = true;
      return;
    }
    held.deciding = true;
    let gate: CSharpGate;
    do {
      held.decideAgain = false;
      gate = await this.gateWithin(held.context);
    } while (held.decideAgain && this.held.get(held.ws) === held);
    held.deciding = false;
    if (this.held.get(held.ws) !== held) return;
    if (gate.open) this.openGate(held, gate.launch);
    else this.keepHolding(held, gate);
  }

  /** Git or `dotnet` that never finishes must not leave the client's `initialize` unanswered. */
  private gateWithin(context: WtLspContext): Promise<CSharpGate> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<CSharpGate>((resolve) => {
      timer = setTimeout(() => {
        this.log.warn("Deciding whether csharp-ls may run timed out", { wtPath: context.wtPath });
        resolve(COULD_NOT_TELL);
      }, this.gateTimeoutMs);
    });
    return Promise.race([this.gate(context), deadline]).finally(() => clearTimeout(timer));
  }

  private openGate(held: HeldConnection, launch: CSharpLaunch): void {
    const { ws, context, frames } = held;
    if (!frames) {
      // The client's `initialize` went to this hold: only a new connection gets a real one.
      this.log.info("Reconnecting: csharp-ls can start now", { wtPath: context.wtPath });
      this.releaseHeld(ws);
      ws.close(LSP_RESTART_CLOSE_CODE, "csharp-ls can start now; reconnect");
      return;
    }
    this.releaseHeld(ws);
    this.launches.set(context.wtPath, launch);
    super.startSession(ws, context);
    this.launches.delete(context.wtPath);
    for (const frame of frames) super.handleMessage(ws, frame);
  }

  private keepHolding(held: HeldConnection, gate: ClosedGate): void {
    if (held.frames) {
      const { frames } = held;
      held.frames = null;
      this.watchForChanges(held);
      for (const frame of frames) this.answerHeld(held, frame);
    }
    // A trust change restarts it: `repoTrusted` is fixed for a connection's life.
    if (isRepoTrusted(held.context.wtPath) !== held.context.repoTrusted) {
      this.releaseHeld(held.ws);
      held.ws.close(LSP_RESTART_CLOSE_CODE, "Repository trust changed; reconnect");
      return;
    }
    // A check that could not finish says nothing new, and is worth another look.
    const { notice } = gate.retry ? { notice: held.notice } : gate;
    if (gate.state) publishCSharpLspState(held.context.wtPath, gate.state);
    const recheck = gate.retry === true || notice?.toolchain === true;
    held.retrying = gate.retry === true;
    held.notice = notice;
    this.sendNotice(held);
    if (recheck && !held.recheck) {
      this.refreshToolchainEnv();
      let ticks = 0;
      held.recheck = setInterval(() => {
        // An install can add a directory the captured login-shell PATH lacks; a capture runs the
        // user's startup files, so it is rarer than the lookups.
        if (++ticks % LOGIN_SHELL_REFRESH_TICKS === 0) this.refreshToolchainEnv();
        void this.recheckToolchain(held);
      }, this.recheckMs);
    } else if (!recheck && held.recheck) {
      clearInterval(held.recheck);
      held.recheck = null;
    }
  }

  /**
   * A decision spawns git and `dotnet`, so a tick only takes one when something it depends on looks
   * different, or the last one could not finish. Not while one runs: a slow machine must not keep a
   * decision from ever finishing.
   */
  private async recheckToolchain(held: HeldConnection): Promise<void> {
    const stamp = await toolchainStamp(held.context.wtPath);
    if (this.held.get(held.ws) !== held || held.deciding) return;
    if (stamp === held.toolchainStamp && !held.retrying) return;
    held.toolchainStamp = stamp;
    await this.decide(held);
  }

  protected refreshToolchainEnv(): void {
    void refreshLoginShellEnv();
  }

  private watchForChanges(held: HeldConnection): void {
    // No watching, and none of the git it spawns, for a repository that is not trusted.
    if (!held.context.repoTrusted) return;
    held.stops.push(
      subscribeCSharpRestore(held.context.wtPath, () => {
        if (this.held.get(held.ws) === held) void this.decide(held);
      }),
    );
  }

  private releaseHeld(ws: ServerWebSocket<unknown>): void {
    const held = this.held.get(ws);
    if (!held) return;
    this.held.delete(ws);
    if (held.recheck) clearInterval(held.recheck);
    for (const stop of held.stops) stop();
  }

  /**
   * One connection per worktree, like the base's sessions: the newer one takes over at once, not
   * only once it gets a server, since it may never get one.
   */
  private replaceOthersFor(wtPath: string): void {
    const others = [
      ...[...this.held.values()].filter((held) => held.context.wtPath === wtPath),
      ...[...this.sessions.values()].filter((session) => session.wtPath === wtPath),
    ];
    for (const { ws } of others) {
      this.detach(ws);
      try {
        ws.close(LSP_REPLACED_CLOSE_CODE, "Replaced by newer connection");
      } catch (err) {
        this.log.debug("close() on a replaced WebSocket threw (already closed)", { error: err });
      }
    }
  }

  /** The handshake with nothing behind it. Nothing else is asked of a server with no capabilities. */
  private answerHeld(held: HeldConnection, data: string): void {
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(message) || typeof message.method !== "string") return;
    const { id, method } = message;
    if (method === "initialized") {
      held.initialized = true;
      this.sendNotice(held);
      return;
    }
    if (typeof id !== "number" && typeof id !== "string") return;
    if (method === "initialize") {
      this.sendHeld(held, {
        id,
        result: {
          capabilities: { textDocumentSync: { openClose: false, change: 0 } },
          serverInfo: { name: CSHARP_LS },
        },
      });
    } else if (method === "shutdown") {
      this.sendHeld(held, { id, result: null });
    } else {
      this.sendHeld(held, { id, error: { code: -32601, message: `Unhandled method ${method}` } });
    }
  }

  private sendNotice(held: HeldConnection): void {
    const message = held.notice?.message ?? null;
    if (!held.initialized || message === held.sentNotice) return;
    held.sentNotice = message;
    if (!message) return;
    this.warn(held.ws, message);
  }

  private sendHeld(held: HeldConnection, message: Record<string, unknown>): void {
    this.sendFrame(held.ws, message);
  }

  private warn(ws: ServerWebSocket<unknown>, message: string): void {
    this.sendFrame(ws, {
      method: "window/showMessage",
      params: { type: MESSAGE_TYPE_WARNING, message },
    });
  }

  private sendFrame(ws: ServerWebSocket<unknown>, message: Record<string, unknown>): void {
    try {
      ws.send(JSON.stringify({ jsonrpc: "2.0", ...message }));
    } catch (err) {
      this.log.debug("send() on a closed csharp-ls WebSocket threw", { error: err });
    }
  }

  /**
   * Whether csharp-ls may run for a worktree, and how. Trust comes first, since none of the rest may
   * run git or `dotnet` in a repository that is not trusted. A worktree with no project stays
   * quiet: there is nothing to do about a loose file, and csharp-ls exits with nothing to load. The
   * toolchain comes before the restored state, since `dotnet restore` needs it.
   */
  protected async gate({ wtPath, repoTrusted }: WtLspContext): Promise<CSharpGate> {
    try {
      if (!repoTrusted || !isRepoTrusted(wtPath)) return UNTRUSTED;
      const discovered = await discoverCSharpProjects(wtPath);
      const { projects, solutions, defaultTarget } = discovered;
      if (projects.length === 0) return NO_PROJECT;
      const pick = await pickCSharpLs(wtPath);
      if (pick === null) return COULD_NOT_TELL;
      if ("notice" in pick) return closedBy(pick.notice);
      const chosen = getCSharpSolution(wtPath);
      const target = loadTarget(discovered, chosen);
      const loaded = target ? await solutionProjects(target, projects) : projects;
      const states = await mapWithConcurrency(loaded, CHECK_CONCURRENCY, (project) =>
        csharpRestoreState(wtPath, project),
      );
      if (!states.some(isLoadable)) {
        return closedBy({
          message: `Run \`dotnet restore\` in a terminal to load this repository's C# projects. ${NO_FEATURES}`,
          toolchain: false,
          block: "not-restored",
        });
      }
      return {
        open: true,
        launch: {
          ...pick,
          args: target ? ["--solution", target] : [],
          target,
          projects: loaded,
          notices: [
            ...launchNotices(wtPath, defaultTarget, solutions, target, target === chosen, states),
            ...(await nugetSdkNotices(loaded)),
          ],
        },
      };
    } catch (err) {
      this.log.warn("Could not decide whether csharp-ls may run", { wtPath, error: err });
      return COULD_NOT_TELL;
    }
  }

  // -------------------------------------------------------------------------
  // The server

  protected resolveBinary(context: WtLspContext): string | null {
    return this.launches.get(context.wtPath)?.command ?? null;
  }

  protected override spawnArgs(context: WtLspContext): readonly string[] {
    const launch = this.launches.get(context.wtPath);
    return [...(launch?.prefixArgs ?? []), "--loglevel", "information", ...(launch?.args ?? [])];
  }

  protected override spawnOptions(context: WtLspContext): SpawnOptions {
    const env = this.launches.get(context.wtPath)?.env;
    return { cwd: context.wtPath, env: env && definedEnv(env) };
  }

  protected override workspaceConfiguration(
    _session: WtLspSession,
    section: string | undefined,
  ): Promise<unknown> {
    return Promise.resolve(section === "csharp" ? CSHARP_LS_SETTINGS : null);
  }

  protected override buildSession(
    ws: ServerWebSocket<unknown>,
    proc: Subprocess,
    context: WtLspContext,
  ): WtLspSession {
    const session = super.buildSession(ws, proc, context);
    const launch = this.launches.get(context.wtPath);
    this.launchNotices.set(session, launch?.notices ?? []);
    this.launchTargets.set(session, launch?.target ?? null);
    if (launch) {
      publishCSharpLspState(context.wtPath, {
        kind: "running",
        target: launch.target,
        projects: [...launch.projects],
        sdkVersion: launch.sdkVersion,
      });
    }
    let restored: string | null = null;
    this.restoreStops.set(
      session,
      subscribeCSharpRestore(context.wtPath, ({ states }) => {
        const now = JSON.stringify(states.filter(isLoadable).map((state) => state.project));
        restored ??= now;
        if (now !== restored) this.restartAfterRestore(session);
      }),
    );
    return session;
  }

  protected override onClientInitialized(session: WtLspSession): void {
    for (const message of this.launchNotices.get(session) ?? []) this.warn(session.ws, message);
  }

  /** csharp-ls only logs a project that fails to load, in a message nothing shows. */
  protected override handleServerFrame(session: WtLspSession, body: string): void {
    const unloaded = solutionLoadFailureIn(body);
    // A stopped server's last frames still arrive, after its replacement has decided.
    if (unloaded && this.isSessionLive(session)) {
      publishCSharpLspState(session.wtPath, {
        kind: "blocked",
        block: "load-failed",
        message: unloaded,
      });
    }
    const failure = loadFailureIn(body);
    if (failure) this.noteLoadFailure(session, path.basename(failure[1]!), failure[2] ?? null);
    super.handleServerFrame(session, withClientRegistrations(body));
  }

  private noteLoadFailure(session: WtLspSession, project: string, reason: string | null): void {
    const known = this.loadFailures.get(session);
    const timer = setTimeout(() => this.reportLoadFailures(session), this.loadFailureSettleMs);
    if (known) clearTimeout(known.timer);
    const entry = {
      projects: (known?.projects ?? new Set<string>()).add(project),
      reason: known?.reason ?? reason,
      timer,
    };
    this.loadFailures.set(session, entry);
  }

  private reportLoadFailures(session: WtLspSession): void {
    const failures = this.loadFailures.get(session);
    this.loadFailures.delete(session);
    if (!failures || !this.isSessionLive(session)) return;
    const projects = namedList([...failures.projects]);
    const why = failures.reason ? ` (${failures.reason.trim()})` : "";
    this.warn(
      session.ws,
      `csharp-ls could not load ${projects}${why}. Language features may be missing for their files.`,
    );
  }

  protected override onSessionClosed(session: WtLspSession): void {
    this.launchNotices.delete(session);
    // This runs again when the process has exited, by when a newer connection may have decided.
    if (this.launchTargets.delete(session)) {
      publishCSharpLspState(session.wtPath, { kind: "stopped" });
    }
    clearTimeout(this.loadFailures.get(session)?.timer);
    this.loadFailures.delete(session);
    this.restoreStops.get(session)?.();
    this.restoreStops.delete(session);
    clearTimeout(this.restoreRestarts.get(session));
    this.restoreRestarts.delete(session);
  }

  /**
   * A build target that rewrites its assets file while the project loads would otherwise restart the
   * server for good; past the cap the running server stays, until the window has passed.
   */
  private mayRestartForRestore(wtPath: string): boolean {
    const now = Date.now();
    const recent = (this.restoreRestartTimes.get(wtPath) ?? []).filter(
      (time) => now - time < RESTORE_RESTART_WINDOW_MS,
    );
    const allowed = recent.length < MAX_RESTORE_RESTARTS;
    if (allowed) recent.push(now);
    else this.log.warn("Not restarting csharp-ls again for its restored state", { wtPath });
    this.restoreRestartTimes.set(wtPath, recent);
    return allowed;
  }

  /**
   * A restore changed what a running server should load, or `obj` went away. csharp-ls goes on with
   * the references it read at load, reported files or not, so it starts again: on the new connection
   * the gate decides, which may mean no server. Waits for a restore's writes to end.
   */
  private restartAfterRestore(session: WtLspSession): void {
    clearTimeout(this.restoreRestarts.get(session));
    this.restoreRestarts.set(
      session,
      setTimeout(() => {
        this.restoreRestarts.delete(session);
        if (!this.isSessionLive(session) || !this.mayRestartForRestore(session.wtPath)) return;
        this.log.info("Restarting csharp-ls: the restored state changed", {
          wtPath: session.wtPath,
        });
        const { ws } = session;
        this.detach(ws);
        ws.close(LSP_RESTART_CLOSE_CODE, "The restored state changed; reconnect");
      }, this.restoreSettleMs),
    );
  }
}

/**
 * The server's dynamic registrations as the client takes them. monaco-lsp-client names the semantic
 * tokens capability by its request, and refuses a whole request over a method it does not know,
 * losing the registrations after it. Code lenses go: theirs are reference counts whose command
 * nothing runs, a line above every member that looks clickable and does nothing.
 */
export function withClientRegistrations(body: string): string {
  if (!body.includes('"client/registerCapability"')) return body;
  try {
    const frame: unknown = JSON.parse(body);
    if (!isRecord(frame) || frame.method !== "client/registerCapability") return body;
    if (!isRecord(frame.params) || !Array.isArray(frame.params.registrations)) return body;
    frame.params.registrations = frame.params.registrations.flatMap((entry: unknown) => {
      if (!isRecord(entry)) return [entry];
      if (entry.method === "textDocument/codeLens") return [];
      return entry.method === "textDocument/semanticTokens"
        ? [{ ...entry, method: "textDocument/semanticTokens/full" }]
        : [entry];
    });
    return JSON.stringify(frame);
  } catch {
    return body;
  }
}

/** The cheap test first: this runs on every frame. */
function loadFailureIn(body: string): RegExpExecArray | null {
  if (!body.includes("[Failure]")) return null;
  try {
    const frame: unknown = JSON.parse(body);
    if (!isRecord(frame) || frame.method !== "window/logMessage") return null;
    const message = isRecord(frame.params) ? frame.params.message : null;
    return typeof message === "string" ? LOAD_FAILURE_RE.exec(message) : null;
  } catch {
    return null;
  }
}

/** The words of csharp-ls's own message that a solution did not load, or null. */
function solutionLoadFailureIn(body: string): string | null {
  if (!body.includes(SOLUTION_LOAD_FAILURE)) return null;
  try {
    const frame: unknown = JSON.parse(body);
    if (!isRecord(frame) || frame.method !== "window/showMessage") return null;
    const message = isRecord(frame.params) ? frame.params.message : null;
    if (typeof message !== "string" || !message.includes(SOLUTION_LOAD_FAILURE)) return null;
    // What follows the first line is the exception's stack.
    return message.split("\n", 1)[0]!.slice(0, MAX_FAILURE_LENGTH);
  } catch {
    return null;
  }
}

function definedEnv(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

/**
 * Restored, or with a layout these checks cannot read (`assetsPath` null), which may well be: trust
 * already covers loading it, and csharp-ls does not restore anything itself.
 */
function isLoadable(state: CSharpRestoreState): boolean {
  return state.restored || state.assetsPath === null;
}

/** The choice, while discovery still lists it, else what detection picks. */
function loadTarget(discovered: CSharpProjects, chosen: string | null): string | null {
  return chosen !== null && csharpSelectableSolutions(discovered).includes(chosen)
    ? chosen
    : automaticCSharpSolution(discovered);
}

/**
 * The worktree's projects that a solution lists, by reading its text, or all of them when it names
 * none of them that way: what is not restored only matters for what will load.
 */
async function solutionProjects(solution: string, projects: readonly string[]): Promise<string[]> {
  const text = await readSmallText(solution).catch(() => "");
  const listed = new Set(
    path.extname(solution) === SOLUTION_FILTER_EXTENSION
      ? solutionFilterProjects(solution, text)
      : [...text.matchAll(SOLUTION_PROJECT_RE)].map(([, relative]) =>
          path.resolve(path.dirname(solution), relative!.replaceAll("\\", "/")),
        ),
  );
  const members = projects.filter((project) => listed.has(project));
  return members.length > 0 ? members : [...projects];
}

/**
 * What a `.slnf` lists, which is JSON naming its projects relative to the solution it filters. Empty
 * when it does not read that way.
 */
function solutionFilterProjects(filter: string, text: string): string[] {
  try {
    const parsed: unknown = Bun.JSONC.parse(text);
    const solution = isRecord(parsed) ? parsed.solution : null;
    if (!isRecord(solution) || typeof solution.path !== "string") return [];
    if (!Array.isArray(solution.projects)) return [];
    const solutionPath = path.resolve(path.dirname(filter), solution.path.replaceAll("\\", "/"));
    return solution.projects
      .filter((project): project is string => typeof project === "string")
      .map((project) => path.resolve(path.dirname(solutionPath), project.replaceAll("\\", "/")));
  } catch {
    return [];
  }
}

function launchNotices(
  wtPath: string,
  defaultTarget: CSharpProjects["defaultTarget"],
  solutions: readonly string[],
  target: string | null,
  chosen: boolean,
  states: readonly CSharpRestoreState[],
): string[] {
  const notices: string[] = [];
  // One solution at the root is the repository's own, and is not worth a word.
  if (target && !chosen && solutions.length > 1 && defaultTarget?.kind !== "solution") {
    notices.push(
      `This repository has ${solutions.length} solutions, and csharp-ls loads one: ${path.relative(wtPath, target)}. Files outside it get syntax highlighting only. To load another, click the C# item in the status bar or run ${csharpToolchain.selectAction.label}.`,
    );
  }
  const unrestored = states.filter((state) => !isLoadable(state));
  if (unrestored.length > 0) {
    notices.push(
      `${namedList(unrestored.map((state) => path.basename(state.project)))} ${unrestored.length === 1 ? "is" : "are"} not restored, so references to packages show as errors. Run \`dotnet restore\` in a terminal.`,
    );
  }
  return notices;
}

/**
 * What a project gets for an MSBuild SDK that only NuGet delivers: `MSBUILDDISABLENUGETSDKRESOLVER`
 * keeps it from being downloaded at load, and the project then loads without it. Reads the projects'
 * own text, which is where these are named nearly always.
 */
async function nugetSdkNotices(projects: readonly string[]): Promise<string[]> {
  const named = await mapWithConcurrency(projects, CHECK_CONCURRENCY, async (project) => {
    const text = await readSmallText(project).catch(() => "");
    const sdks = [...text.matchAll(PROJECT_SDK_RE)].flatMap(([, attribute, element]) =>
      (attribute ?? element ?? "").split(";"),
    );
    return sdks.some((sdk) => sdk.trim() !== "" && !BUNDLED_SDK_RE.test(sdk.trim()))
      ? [path.basename(project)]
      : [];
  });
  const affected = named.flat();
  if (affected.length === 0) return [];
  return [
    `${namedList(affected)} ${affected.length === 1 ? "uses" : "use"} an MSBuild SDK from NuGet, which csharp-ls does not load here, since that could download it. Expect errors in ${affected.length === 1 ? "its" : "their"} files.`,
  ];
}

/** A few names and how many more, for a message that stays readable in a large repository. */
function namedList(names: readonly string[]): string {
  const shown = names.slice(0, MAX_NAMED_PROJECTS).join(", ");
  const more = names.length - MAX_NAMED_PROJECTS;
  return more > 0 ? `${shown} and ${more} more` : shown;
}

/**
 * `{ notice }` when there is no csharp-ls to run, or nothing it could run on, and null when `dotnet`
 * would not say.
 */
async function pickCSharpLs(wtPath: string): Promise<ToolLaunch | { notice: GateNotice } | null> {
  const spawnEnv = buildSpawnEnv();
  const dotnet = await resolveDotnet(wtPath, { env: spawnEnv });
  if (!dotnet) {
    return {
      notice: toolchainNotice(
        "no-dotnet",
        `C# language features need the .NET SDK, which Loxel did not find on your PATH. Install the .NET ${MIN_RUNTIME_MAJOR} SDK, then run \`${INSTALL_COMMAND}\` in a terminal.`,
      ),
    };
  }
  const local = readDotnetToolManifests(wtPath).some(
    ({ tools }) =>
      isRecord(tools) && Object.values(tools).some((tool) => toolClaimsCommand(tool, CSHARP_LS)),
  );
  const globalTool = local ? null : await resolveGlobalDotnetTool(wtPath, CSHARP_LS);
  const runtimes = await dotnetRuntimes(wtPath, { env: spawnEnv });
  const sdks = await dotnetSdks(wtPath, { env: spawnEnv });
  if (sdks === null || runtimes === null) return null;
  if (!runtimes.runtime10Root) {
    const then = local || globalTool ? "" : `, then run \`${INSTALL_COMMAND}\``;
    return {
      notice: toolchainNotice(
        "no-dotnet",
        `csharp-ls needs .NET ${MIN_RUNTIME_MAJOR}. Install the .NET ${MIN_RUNTIME_MAJOR} SDK next to the ones you have, which your projects keep using${then}.`,
      ),
    };
  }
  if (sdks.length === 0) {
    return {
      notice: toolchainNotice(
        "no-dotnet",
        "Loading a C# project needs a .NET SDK, and Loxel found only a runtime. Install the .NET SDK.",
      ),
    };
  }
  const selectedSdk = await dotnetSdkVersion(wtPath, { env: spawnEnv });
  if (!selectedSdk) {
    return { notice: toolchainNotice("no-dotnet", await missingSdkMessage(wtPath, spawnEnv)) };
  }

  const env: Record<string, string | undefined> = {
    ...dotnetSpawnEnv(wtPath, spawnEnv),
    ...CSHARP_LS_ENV,
    // csharp-ls's launcher looks here for its runtime, which a `dotnet` on PATH does not tell it.
    DOTNET_ROOT: runtimes.runtime10Root,
  };
  if (local) return pickLocalTool(wtPath, env, selectedSdk);
  if (!globalTool) {
    return { notice: toolchainNotice("no-csharp-ls", installMessage(sdks, selectedSdk)) };
  }
  const version = await globalToolVersion(globalTool, env);
  if (!version) {
    return {
      notice: toolchainNotice(
        "csharp-ls-failed",
        "csharp-ls is installed but did not run. Run `csharp-ls --version` in a terminal to see why.",
      ),
    };
  }
  if (Bun.semver.order(version, MIN_CSHARP_LS_VERSION) < 0) {
    return {
      notice: toolchainNotice(
        "old-csharp-ls",
        `csharp-ls ${version} is older than Loxel needs (${MIN_CSHARP_LS_VERSION}). Run \`${UPDATE_COMMAND}\` in a terminal.`,
      ),
    };
  }
  return { command: globalTool, prefixArgs: [], env, sdkVersion: selectedSdk };
}

/**
 * `dotnet tool install` fails with an error about the package's settings under any SDK older than
 * the one the tool targets, an older one that `global.json` selects included. So the message leads
 * with what avoids that.
 */
function installMessage(sdks: readonly string[], selectedSdk: string | null): string {
  const isNew = (sdk: string) => Number.parseInt(sdk, 10) >= MIN_RUNTIME_MAJOR;
  if (!sdks.some(isNew)) {
    return `Installing csharp-ls needs the .NET ${MIN_RUNTIME_MAJOR} SDK. Install it next to the ones you have, which your projects keep using, then run \`${INSTALL_COMMAND}\` in a terminal.`;
  }
  const where = selectedSdk && !isNew(selectedSdk) ? " from outside this repository" : "";
  return `C# language features need csharp-ls. Run \`${INSTALL_COMMAND}\` in a terminal${where}.`;
}

/** `dotnet` found no SDK for the worktree though it has some: usually `global.json` asks for another. */
async function missingSdkMessage(
  wtPath: string,
  env: Record<string, string | undefined>,
): Promise<string> {
  const pin = await inspectGlobalJson(wtPath, wtPath, { env });
  const check = "run `dotnet --version` in the repository to see what it needs";
  if (!pin) return `\`dotnet\` could not pick an SDK for this repository. In a terminal, ${check}.`;
  const wanted = pin.sdkVersion ? `.NET SDK ${pin.sdkVersion}` : "a .NET SDK";
  return `This repository's global.json selects ${wanted}, which is not installed. Install it, or ${check}.`;
}

/** The local tool, run through `dotnet` from the worktree, once `dotnet` says it can run it. */
async function pickLocalTool(
  wtPath: string,
  env: Record<string, string | undefined>,
  sdkVersion: string,
): Promise<ToolLaunch | { notice: GateNotice } | null> {
  // A manifest's tool is the repository's choice: this runs it, unlike anything before it.
  if (!isRepoTrusted(wtPath)) return null;
  const prepared = await prepareDotnet(wtPath, { env });
  if (!prepared) {
    return {
      notice: toolchainNotice("no-dotnet", "Loxel could not run `dotnet` in this repository."),
    };
  }
  const prefixArgs = ["tool", "run", CSHARP_LS, "--"];
  const version = await readVersion(prepared.dotnetPath, [...prefixArgs, "--version"], wtPath, env);
  if (!version) {
    return {
      notice: toolchainNotice(
        "csharp-ls-failed",
        "This repository's tool manifest lists csharp-ls, which did not run. Run `dotnet tool restore` in a terminal; if it still does not start, `dotnet tool run csharp-ls -- --version` shows why.",
      ),
    };
  }
  if (Bun.semver.order(version, MIN_CSHARP_LS_VERSION) < 0) {
    return {
      notice: toolchainNotice(
        "old-csharp-ls",
        `This repository's tool manifest pins csharp-ls ${version}, older than Loxel needs (${MIN_CSHARP_LS_VERSION}). Update it in the manifest, then run \`dotnet tool restore\`.`,
      ),
    };
  }
  return { command: prepared.dotnetPath, prefixArgs, env, sdkVersion };
}

/**
 * What a toolchain decision depends on, with stats only: `dotnet` and csharp-ls and which ones they
 * are, the SDKs and runtimes `dotnet` has, the worktree's own `global.json` and tool manifests, and
 * the local tool cache that `dotnet tool restore` writes.
 */
async function toolchainStamp(wtPath: string): Promise<string> {
  const env = buildSpawnEnv();
  const search = { PATH: env.PATH ?? "" };
  const dotnet = Bun.which(DOTNET, search);
  const install = dotnet ? path.dirname(await realpath(dotnet).catch(() => dotnet)) : null;
  const toolsHome = path.dirname(dotnetGlobalToolsDir(env));
  const inputs = [
    dotnet,
    Bun.which(CSHARP_LS, search),
    path.join(dotnetGlobalToolsDir(env), CSHARP_LS),
    // Written as `<cache version>/<package id>`; a directory's stamp misses a file rewritten in place.
    path.join(toolsHome, "toolResolverCache", "1"),
    path.join(toolsHome, "toolResolverCache", "1", CSHARP_LS),
    ...(install ? [path.join(install, "sdk"), path.join(install, "shared", NETCORE_APP)] : []),
    env.DOTNET_ROOT ? path.join(env.DOTNET_ROOT, "shared", NETCORE_APP) : null,
    path.join(wtPath, "global.json"),
    path.join(wtPath, "dotnet-tools.json"),
    path.join(wtPath, ".config", "dotnet-tools.json"),
  ].filter((input) => input !== null);
  const stamps = await Promise.all(
    inputs.map(async (input) => `${input}:${(await fileStamp(input)) ?? "missing"}`),
  );
  return [search.PATH, ...stamps].join("\0");
}

/** Per binary while the file is the same, since a held connection asks on every recheck. */
const toolVersions = new Map<string, string>();

/** A global tool's version, asked from the home directory: it depends on nothing in the worktree. */
async function globalToolVersion(
  tool: string,
  env: Record<string, string | undefined>,
): Promise<string | null> {
  const info = await stat(tool);
  const key = `${path.resolve(tool)}\0${info.ino}\0${info.mtimeMs}`;
  const known = toolVersions.get(key);
  if (known) return known;
  const version = await readVersion(tool, ["--version"], homedir(), env);
  if (version) toolVersions.set(key, version);
  return version;
}

async function readVersion(
  command: string,
  args: readonly string[],
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<string | null> {
  const output = await runDotnet(command, [...args], cwd, env);
  return output === null ? null : (VERSION_RE.exec(output)?.[1] ?? null);
}
