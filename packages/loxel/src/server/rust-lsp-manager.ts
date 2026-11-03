import path from "node:path";

import type { ServerWebSocket, Subprocess } from "bun";

import type { RustToolchain } from "@/api/rust-toolchain-model";
import { LSP_RESTART_CLOSE_CODE } from "@/api/ws-protocol";

import { killProcessTrees } from "./kill-process-tree";
import { fileUri } from "./lsp-file-uri";
import { isInside } from "./path-containment";
import { onRepoTrustChange, reportRepoRestriction } from "./repo-trust";
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
  withoutPullDiagnostics,
  withRustClientCapabilities,
} from "./rust-analyzer-run";
import { RustCheckOnChange } from "./rust-check-on-change";
import {
  findRustProject,
  isReadableRustManifest,
  RUST_MANIFEST,
  untrustedNestedRepo,
} from "./rust-project-lookup";
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
  /** A trusted server's checks, which it starts on a save only. */
  checks: RustCheckOnChange | null;
  stopFollowingTrust: () => void;
  /** The client's `initialized` went through: the server takes nothing else before that. */
  initialized: boolean;
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

const TRUST_RESTRICTION =
  "Rust build scripts, proc macros and cargo check don't run, so generated code is unknown and many errors show no marker.";

/**
 * Manages rust-analyzer child processes, one per worktree, running the user's own rust-analyzer from
 * the worktree's toolchain: in full in a trusted repository, and otherwise in a restricted mode
 * (`docs/languages/rust.md`). A session starts only when that holds, and restarts when trust, the
 * toolchain or the worktree's manifests change. Projects elsewhere in the worktree are added as their
 * files open, without a restart.
 */
export class RustLspManager extends WorktreeLspManager {
  protected override readonly repoTrustRestriction = TRUST_RESTRICTION;
  // Reported once a Cargo project is linked: trust adds little to a loose file.
  protected override readonly reportsRestrictionAtStart = false;
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
    const plan = await planRustAnalyzer(
      context.wtPath,
      await getRustToolchain(context.wtPath),
      context.repoTrusted,
    );
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
      manifests: findRustManifests(wtPath, context.repoTrusted),
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
      checks: context.repoTrusted
        ? new RustCheckOnChange(wtPath, {
            linkedProjectOf: (file) => this.linkedProjectOf(state, file, wtPath),
            save: (file) => this.saveFile(session, state, file),
          })
        : null,
      initialized: false,
      stopFollowingTrust: context.repoTrusted
        ? onRepoTrustChange(() => this.followNestedTrust(session, state))
        : () => {},
      checking: Promise.resolve(),
    };
    this.states.set(session, state);
    // A change that landed while the binary was picked and spawned was heard by no one.
    this.queueCheck(session, state, () => getRustToolchainNow(wtPath));
    return session;
  }

  protected override onSessionClosed(session: WtLspSession): void {
    const state = this.states.get(session);
    if (!state) return;
    this.states.delete(session);
    state.unsubscribe();
    state.stopFollowingTrust();
    state.checks?.dispose();
    // rust-analyzer's own stop leaves `cargo` and what it runs behind, and only a trusted server has
    // those. Once the server is gone so is its tree, and its number may be someone else's.
    const { proc } = session;
    if (session.repoTrusted && proc.exitCode === null && proc.signalCode === null) {
      killProcessTrees([proc.pid]);
    }
  }

  // A throw ends the session as a start failure: the server must not run without these settings.
  protected override getInitializationOptions(session: WtLspSession): Record<string, unknown> {
    const state = this.states.get(session);
    if (!state?.plan) throw new Error("rust-analyzer session without a plan");
    return this.settingsOf(state.plan, state);
  }

  /**
   * The server asks after {@link notifyConfigurationChanged}, and what it gets replaces what it was
   * started with, so this is the whole of the settings.
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
    return rustAnalyzerSettings(plan, this.linkedManifests(state), [...state.looseFiles]);
  }

  private linkedManifests(state: SessionState): string[] {
    const manifests = new Set([...state.manifests, ...state.openedManifests]);
    return [...manifests].filter((manifest) => !state.refusedManifests.has(manifest));
  }

  /**
   * The project that checks `file`. A loose file has none. A crate that is not linked itself can
   * still belong to a linked project above it, as a path dependency in its folder does, which only
   * Cargo can tell, and a save there at worst checks that project once more.
   */
  private linkedProjectOf(state: SessionState, file: string, wtPath: string): string | null {
    const project = findRustProject(file, wtPath);
    if (project?.kind !== "manifest") return null;
    const linked = this.linkedManifests(state);
    if (linked.includes(project.manifest)) return project.manifest;
    const above = linked.filter((manifest) => isInside(file, path.dirname(manifest)));
    return above.toSorted((a, b) => b.length - a.length)[0] ?? null;
  }

  /** The one source of `didSave`; the client's stays blocked. */
  private saveFile(session: WtLspSession, state: SessionState, file: string): void {
    // Before that the server would fail the handshake, and the check after its load covers this.
    if (!state.initialized || !this.isSessionLive(session)) return;
    const params = { textDocument: { uri: fileUri(file) } };
    try {
      this.writeToStdin(
        session,
        JSON.stringify({ jsonrpc: "2.0", method: "textDocument/didSave", params }),
      );
    } catch (err) {
      // A server that has closed its stdin, not yet reaped: this runs in a timer.
      this.log.debug("Could not send didSave", { error: err });
    }
  }

  /**
   * A nested repository has an answer of its own, which the base does not follow. One no longer
   * trusted takes a restart, since a project going away leaves its builds and macros behind.
   */
  private followNestedTrust(session: WtLspSession, state: SessionState): void {
    if (!this.isSessionLive(session)) return;
    if (
      this.holdsUntrustedRepo(session, state) ||
      findRustManifests(session.wtPath, true).join("\0") !== state.manifests.join("\0")
    ) {
      this.restart(session, "a nested repository's trust changed");
      return;
    }
    this.queueRefresh(session, state);
  }

  /** Whether a trusted server has come to hold a project of a repository not trusted itself. */
  private holdsUntrustedRepo({ repoTrusted, wtPath }: WtLspSession, state: SessionState): boolean {
    if (!repoTrusted) return false;
    const held = [...state.manifests, ...state.openedManifests, ...state.refusedManifests];
    return held.some((manifest) => untrustedNestedRepo(manifest, wtPath) !== null);
  }

  protected override handleClientData(session: WtLspSession, data: string): void {
    const blocked = blockedClientMethod(data);
    if (!blocked) {
      super.handleClientData(session, withRustClientCapabilities(data, session.repoTrusted));
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
      super.handleServerFrame(session, session.repoTrusted ? withoutPullDiagnostics(body) : body);
      return;
    }
    for (const { kind, message } of status.notices) this.report(session, kind, message);
  }

  protected override onClientInitialized(session: WtLspSession): void {
    const state = this.states.get(session);
    if (state) state.initialized = true;
    if (state?.plan?.rustSrc !== false) return;
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
        const manifests = findRustManifests(session.wtPath, session.repoTrusted);
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
      state.checks?.pathsChanged(paths);
    }
  }

  /** A build writes thousands of ignored files, but a crate in an ignored folder is still one. */
  override notifyIgnoredPathChanged(wtPath: string, relPath: string): void {
    super.notifyIgnoredPathChanged(wtPath, relPath);
    const parts = relPath.split("/");
    if (parts.includes("target")) return;
    const absolute = path.join(wtPath, relPath);
    if (parts.at(-1) === RUST_MANIFEST) {
      this.notifyWatchedFilesChanged(wtPath, [absolute]);
      return;
    }
    if (!relPath.endsWith(".rs")) return;
    const root = path.resolve(wtPath);
    for (const session of this.sessions.values()) {
      if (path.resolve(session.wtPath) === root) {
        this.states.get(session)?.checks?.pathsChanged([absolute]);
      }
    }
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
    // A folder can have become a repository of its own since it was linked.
    if (this.holdsUntrustedRepo(session, state)) {
      this.restart(session, "a project is now in an untrusted repository");
      return;
    }
    const before = JSON.stringify(this.settingsOf(plan, state));
    for (const manifest of state.openedManifests) {
      if (!isReadableRustManifest(manifest, wtPath)) state.openedManifests.delete(manifest);
    }
    for (const manifest of state.refusedManifests) {
      // One that is gone has nothing left to fix, and would be checked and reported again forever.
      if (!isReadableRustManifest(manifest, wtPath)) state.refusedManifests.delete(manifest);
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
      const nested =
        project.kind === "manifest" && session.repoTrusted
          ? untrustedNestedRepo(project.manifest, wtPath)
          : null;
      if (nested !== null) {
        const folder = path.relative(wtPath, nested);
        this.report(
          session,
          `nested:${nested}`,
          `${folder} is a repository of its own that you haven't trusted, so its Rust project isn't loaded here. Open it as a project to trust it.`,
        );
        continue;
      }
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
    if (!session.repoTrusted && this.linkedManifests(state).length > 0) {
      reportRepoRestriction(wtPath, TRUST_RESTRICTION);
    }
    // The answer can have changed during the checks above, which only this catches.
    if (this.holdsUntrustedRepo(session, state)) {
      this.restart(session, "a project is now in an untrusted repository");
      return;
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
    const next = await planRustAnalyzer(session.wtPath, toolchain, session.repoTrusted);
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
