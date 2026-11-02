import path from "node:path";

import type { ServerWebSocket, Subprocess } from "bun";

import type { RustToolchain } from "@/api/rust-toolchain-model";
import { LSP_RESTART_CLOSE_CODE } from "@/api/ws-protocol";

import {
  blockedClientMethod,
  findRustManifests,
  isRustManifestPath,
  planRustAnalyzer,
  readDocumentLifecycle,
  readServerStatus,
  type RustAnalyzerPlan,
  rustAnalyzerSettings,
  rustManifestProblem,
  withRustClientCapabilities,
} from "./rust-analyzer-run";
import { findRustProject, isReadableRustManifest, RUST_MANIFEST } from "./rust-project-lookup";
import { getRustToolchain, getRustToolchainNow, subscribeRustToolchain } from "./rust-toolchain";
import {
  type SpawnOptions,
  type SuppressibleFeature,
  WorktreeLspManager,
  type WtLspContext,
  type WtLspSession,
} from "./stdio-lsp-manager";

type RunPlan = Extract<RustAnalyzerPlan, { kind: "run" }>;

interface SessionState {
  plan: RunPlan | null;
  /** What a start loads by itself; a change to these restarts the server. */
  manifests: string[];
  /** Projects added for files opened since the start, and the files outside any project. */
  openedManifests: Set<string>;
  looseFiles: Set<string>;
  /** The Rust files open now; what they need is looked up again when a manifest changes. */
  openFiles: Set<string>;
  /** Manifests kept out for failing their check, until they pass it. */
  refusedManifests: Set<string>;
  /** Check what is linked at the next refresh: first at the start, then after a manifest change. */
  recheckManifests: boolean;
  /** No refresh has checked yet, so what fails now has never loaded. */
  neverChecked: boolean;
  /** One refresh at a time; one waiting to start covers any change made meanwhile. */
  refreshing: Promise<void>;
  refreshQueued: boolean;
  unsubscribe: () => void;
  /** One check at a time, so the last resolution decides. */
  checking: Promise<void>;
}

/** JSON-RPC's `MethodNotFound`. */
const METHOD_NOT_FOUND = -32601;

/** LSP `MessageType.Warning`. */
const MESSAGE_TYPE_WARNING = 2;

/**
 * How many projects a session adds for opened files. Each stays loaded until the server restarts,
 * and a project the size of ripgrep already takes 500 MB or more.
 */
export const MAX_OPENED_RUST_PROJECTS = 10;

const SETTINGS_SECTION = "rust-analyzer";

/**
 * Manages rust-analyzer child processes, one per worktree, running the user's own rust-analyzer from
 * the worktree's toolchain in a restricted mode (`docs/languages/rust.md`). A session starts only
 * when that holds, and restarts when the toolchain or the worktree's manifests change. Projects
 * elsewhere in the worktree are added as their files open, without a restart.
 */
export class RustLspManager extends WorktreeLspManager {
  protected override readonly forwardWatchedFiles = true;
  /** Format on save owns Rust, and the server's formatting can run a repository's command. */
  protected override readonly suppressedFeatures: readonly SuppressibleFeature[] = [
    "textDocument/formatting",
    "textDocument/rangeFormatting",
  ];
  /** What each session has told the user already. */
  private readonly reported = new WeakMap<WtLspSession, Set<string>>();
  /** What each start decided, from `resolveBinary` on. */
  private readonly plans = new WeakMap<WtLspContext, RustAnalyzerPlan>();
  private readonly states = new WeakMap<WtLspSession, SessionState>();

  constructor() {
    super("rust-lsp");
  }

  protected async resolveBinary(context: WtLspContext): Promise<string | null> {
    const plan = await planRustAnalyzer(context.wtPath, await getRustToolchain(context.wtPath));
    this.plans.set(context, plan);
    if (plan.kind === "refuse") {
      this.log.info("Not starting rust-analyzer", { wtPath: context.wtPath, reason: plan.reason });
      return null;
    }
    return plan.binary;
  }

  protected override serverFailureReason(context: WtLspContext): string | null {
    const plan = this.plans.get(context);
    return plan?.kind === "refuse" ? plan.reason : null;
  }

  protected override spawnArgs(): readonly string[] {
    return [];
  }

  protected override spawnOptions(context: WtLspContext): SpawnOptions {
    const plan = this.plans.get(context);
    // Thrown, it is a start failure: the server must not run without this environment.
    if (plan?.kind !== "run") throw new Error("rust-analyzer started without a plan");
    return { cwd: context.wtPath, env: plan.env };
  }

  protected override buildSession(
    ws: ServerWebSocket<unknown>,
    proc: Subprocess,
    context: WtLspContext,
  ): WtLspSession {
    const session = super.buildSession(ws, proc, context);
    const { wtPath } = context;
    const plan = this.plans.get(context);
    const state: SessionState = {
      plan: plan?.kind === "run" ? plan : null,
      manifests: findRustManifests(wtPath),
      openedManifests: new Set(),
      looseFiles: new Set(),
      openFiles: new Set(),
      refusedManifests: new Set(),
      recheckManifests: true,
      neverChecked: true,
      refreshing: Promise.resolve(),
      refreshQueued: false,
      unsubscribe: subscribeRustToolchain(wtPath, ({ toolchain }) => {
        this.queueCheck(session, state, () => Promise.resolve(toolchain));
      }),
      checking: Promise.resolve(),
    };
    this.states.set(session, state);
    // A change that landed while the binary was picked and spawned was heard by no one.
    this.queueCheck(session, state, () => getRustToolchainNow(wtPath));
    return session;
  }

  protected override onSessionClosed(session: WtLspSession): void {
    this.states.get(session)?.unsubscribe();
    this.states.delete(session);
  }

  // A throw ends the session as a start failure: the server must not run without these settings.
  protected override getInitializationOptions(session: WtLspSession): Record<string, unknown> {
    const state = this.states.get(session);
    if (!state?.plan) throw new Error("rust-analyzer session without a plan");
    return this.settingsOf(state.plan, state);
  }

  /**
   * The server asks after {@link notifyConfigurationChanged}, and what it gets replaces what it was
   * started with, so this is the whole of the restricted settings.
   */
  protected override workspaceConfiguration(
    session: WtLspSession,
    section: string | undefined,
  ): Promise<unknown> {
    const state = this.states.get(session);
    if (section !== SETTINGS_SECTION || !state?.plan) return Promise.resolve(null);
    return Promise.resolve(this.settingsOf(state.plan, state));
  }

  private settingsOf(plan: RunPlan, state: SessionState): Record<string, unknown> {
    const manifests = new Set(
      [...state.manifests, ...state.openedManifests].filter(
        (manifest) => !state.refusedManifests.has(manifest),
      ),
    );
    return rustAnalyzerSettings(plan, [...manifests], [...state.looseFiles]);
  }

  protected override handleClientData(session: WtLspSession, data: string): void {
    const blocked = blockedClientMethod(data);
    if (!blocked) {
      super.handleClientData(session, withRustClientCapabilities(data));
      this.trackDocument(session, data);
      return;
    }
    this.log.debug("Not forwarding a client method", { method: blocked.method });
    // A request still gets its answer; a notification has none.
    if (blocked.id === undefined) return;
    const error = { code: METHOD_NOT_FOUND, message: `${blocked.method} is not available` };
    session.ws.send(JSON.stringify({ jsonrpc: "2.0", id: blocked.id, error }));
  }

  protected override handleServerFrame(session: WtLspSession, body: string): void {
    const status = readServerStatus(body, session.wtPath);
    if (!status) {
      super.handleServerFrame(session, body);
      return;
    }
    for (const { kind, message } of status.notices) this.report(session, kind, message);
  }

  protected override onClientInitialized(session: WtLspSession): void {
    if (this.states.get(session)?.plan?.rustSrc !== false) return;
    this.report(
      session,
      "rust-src",
      "The standard library's sources are not installed, so its items are unknown. Run: rustup component add rust-src",
    );
  }

  /** Tell the user, through the client's `showMessages`, once per session and kind. */
  private report(session: WtLspSession, kind: string, message: string): void {
    const reported = this.reported.get(session) ?? new Set();
    this.reported.set(session, reported);
    if (reported.has(kind)) return;
    reported.add(kind);
    const params = { type: MESSAGE_TYPE_WARNING, message };
    session.ws.send(JSON.stringify({ jsonrpc: "2.0", method: "window/showMessage", params }));
  }

  override notifyWatchedFilesChanged(wtPath: string, paths: readonly string[]): void {
    super.notifyWatchedFilesChanged(wtPath, paths);
    const manifestChanged = paths.some((changed) => path.basename(changed) === RUST_MANIFEST);
    const root = path.resolve(wtPath);
    for (const session of this.sessions.values()) {
      if (path.resolve(session.wtPath) !== root) continue;
      const state = this.states.get(session);
      if (!state) continue;
      if (paths.some((changed) => isRustManifestPath(wtPath, changed))) {
        const manifests = findRustManifests(session.wtPath);
        if (manifests.join("\0") !== state.manifests.join("\0")) {
          this.restart(session, "manifests changed");
          continue;
        }
      }
      // Left to the refresh, so a check already running cannot overwrite what this one finds.
      if (manifestChanged) state.recheckManifests = true;
      if (manifestChanged || paths.some((changed) => state.openFiles.has(changed))) {
        this.queueRefresh(session, state);
      }
    }
  }

  /** A build writes thousands of ignored files, but a crate in an ignored folder is still one. */
  override notifyIgnoredPathChanged(wtPath: string, relPath: string): void {
    super.notifyIgnoredPathChanged(wtPath, relPath);
    const parts = relPath.split("/");
    if (parts.at(-1) !== RUST_MANIFEST || parts.includes("target")) return;
    this.notifyWatchedFilesChanged(wtPath, [path.join(wtPath, relPath)]);
  }

  /** Follow the client's open documents; a newly open one can need a project loaded. */
  private trackDocument(session: WtLspSession, data: string): void {
    const document = readDocumentLifecycle(data);
    const state = this.states.get(session);
    if (!document || !state) return;
    if (!document.opened) {
      state.openFiles.delete(document.file);
      return;
    }
    state.openFiles.add(document.file);
    this.queueRefresh(session, state);
  }

  private queueRefresh(session: WtLspSession, state: SessionState): void {
    if (state.refreshQueued) return;
    state.refreshQueued = true;
    state.refreshing = state.refreshing
      .then(() => {
        state.refreshQueued = false;
        return this.refreshProjects(session, state);
      })
      .catch((err: unknown) => {
        this.log.warn("Could not update rust-analyzer's projects", { error: err });
      });
  }

  /**
   * Bring the session's projects up to date with its open files and the manifests on disk, and tell
   * the server if that changed them. A project stays when its files close: unloading it would mean
   * indexing it again on the next open.
   */
  private async refreshProjects(session: WtLspSession, state: SessionState): Promise<void> {
    const { plan } = state;
    if (!plan || !this.isSessionLive(session)) return;
    const { wtPath } = session;
    const before = JSON.stringify(this.settingsOf(plan, state));
    for (const manifest of state.openedManifests) {
      if (!isReadableRustManifest(manifest, wtPath)) state.openedManifests.delete(manifest);
    }
    for (const file of state.looseFiles) {
      // Closed ones go too: they cost nothing to bring back.
      const isLoose = findRustProject(file, wtPath)?.kind === "loose";
      if (!isLoose || !state.openFiles.has(file)) state.looseFiles.delete(file);
    }
    if (state.recheckManifests && !(await this.recheckManifests(session, state, plan))) return;
    for (const file of state.openFiles) {
      const project = findRustProject(file, wtPath);
      if (!project) continue;
      const known =
        project.kind === "loose"
          ? state.looseFiles.has(project.file)
          : state.manifests.includes(project.manifest) ||
            state.openedManifests.has(project.manifest) ||
            state.refusedManifests.has(project.manifest);
      if (known) continue;
      if (project.kind === "loose") {
        state.looseFiles.add(project.file);
        continue;
      }
      if (
        state.openedManifests.size + (state.looseFiles.size > 0 ? 1 : 0) >=
        MAX_OPENED_RUST_PROJECTS
      ) {
        this.report(
          session,
          "project-limit",
          `Loxel adds at most ${MAX_OPENED_RUST_PROJECTS} Rust projects as their files open, so ${path.relative(wtPath, file)} has no language features. Close files from the others, then Restart Language Servers.`,
        );
        continue;
      }
      const problem = await rustManifestProblem(plan, project.manifest);
      if (!this.isSessionLive(session)) return;
      if (problem === null) {
        state.openedManifests.add(project.manifest);
        continue;
      }
      state.refusedManifests.add(project.manifest);
      this.reportManifestProblem(session, project.manifest, problem);
    }
    if (JSON.stringify(this.settingsOf(plan, state)) === before) return;
    this.log.info("Updating rust-analyzer's projects", {
      wtPath,
      opened: state.openedManifests.size,
      looseFiles: state.looseFiles.size,
    });
    this.notifyConfigurationChanged(session);
  }

  /**
   * Check every manifest that is linked or was refused, and tell about those that fail. One that
   * never loaded stays out, since it would keep the server from taking in anything else. One that
   * did stays linked: the server keeps its last good state, and fixing it lets the rest in. False
   * when the session ended meanwhile.
   */
  private async recheckManifests(
    session: WtLspSession,
    state: SessionState,
    plan: RunPlan,
  ): Promise<boolean> {
    state.recheckManifests = false;
    this.forgetProjectReports(session);
    const refused = new Set(state.refusedManifests);
    const linked = [...state.manifests, ...state.openedManifests];
    const refuseFailures = state.neverChecked;
    state.neverChecked = false;
    for (const manifest of new Set([...linked, ...refused])) {
      const problem = await rustManifestProblem(plan, manifest);
      if (!this.isSessionLive(session)) return false;
      if (problem === null) {
        state.refusedManifests.delete(manifest);
        continue;
      }
      if (refuseFailures || refused.has(manifest)) state.refusedManifests.add(manifest);
      this.reportManifestProblem(session, manifest, problem);
    }
    return true;
  }

  private reportManifestProblem(session: WtLspSession, manifest: string, problem: string): void {
    const folder = path.relative(session.wtPath, path.dirname(manifest)) || "the worktree root";
    this.report(
      session,
      `project:${manifest}`,
      `Could not load the Rust project in ${folder}. ${problem}`,
    );
  }

  /** Once a manifest changed, what failed may load now, and a new failure is worth telling. */
  private forgetProjectReports(session: WtLspSession): void {
    const reported = this.reported.get(session);
    for (const kind of reported ?? []) {
      if (kind === "project" || kind.startsWith("project:")) reported?.delete(kind);
    }
  }

  /** Check next in line; one that fails restarts the server, not silencing the later ones. */
  private queueCheck(
    session: WtLspSession,
    state: SessionState,
    toolchain: () => Promise<RustToolchain>,
  ): void {
    state.checking = state.checking
      .then(async () => this.checkToolchain(session, state, await toolchain()))
      .catch((err: unknown) => {
        this.log.warn("A rust-analyzer toolchain check failed", { error: err });
        if (this.isSessionLive(session)) this.restart(session, "toolchain check failed");
      });
  }

  /** Restart the session's server when the toolchain now calls for something else. */
  private async checkToolchain(
    session: WtLspSession,
    state: SessionState,
    toolchain: RustToolchain,
  ): Promise<void> {
    if (!this.isSessionLive(session)) return;
    // Gone may be an install in progress; the running server stays on the toolchain it was given.
    if (toolchain.status === "none") return;
    const next = await planRustAnalyzer(session.wtPath, toolchain);
    if (!this.isSessionLive(session)) return;
    if (next.kind === "run" && next.key === state.plan?.key) return;
    this.restart(session, "rust toolchain changed");
  }

  private restart({ ws, wtPath }: WtLspSession, why: string): void {
    this.log.info("Restarting rust-analyzer", { wtPath, why });
    this.detach(ws);
    try {
      ws.close(LSP_RESTART_CLOSE_CODE, `${why}; reconnect`);
    } catch (err) {
      this.log.debug("close() on a restarted server's WebSocket threw (already closed)", {
        error: err,
      });
    }
  }
}
