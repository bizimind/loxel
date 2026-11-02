import path from "node:path";

import type { ServerWebSocket, Subprocess } from "bun";

import type { RustToolchain } from "@/api/rust-toolchain-model";
import { LSP_RESTART_CLOSE_CODE } from "@/api/ws-protocol";

import {
  blockedClientMethod,
  findRustManifests,
  isRustManifestPath,
  planRustAnalyzer,
  type RustAnalyzerPlan,
  rustAnalyzerSettings,
  readServerStatus,
  withRustClientCapabilities,
} from "./rust-analyzer-run";
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
  manifests: string[];
  unsubscribe: () => void;
  /** One check at a time, so the last resolution decides. */
  checking: Promise<void>;
}

/** JSON-RPC's `MethodNotFound`. */
const METHOD_NOT_FOUND = -32601;

/** LSP `MessageType.Warning`. */
const MESSAGE_TYPE_WARNING = 2;

/**
 * Manages rust-analyzer child processes, one per worktree, running the user's own rust-analyzer from
 * the worktree's toolchain in a restricted mode (`docs/languages/rust.md`). A session starts only
 * when that holds, and restarts when the toolchain or the worktree's manifests change.
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
    return rustAnalyzerSettings(state.plan, state.manifests);
  }

  protected override handleClientData(session: WtLspSession, data: string): void {
    const blocked = blockedClientMethod(data);
    if (!blocked) {
      super.handleClientData(session, withRustClientCapabilities(data));
      return;
    }
    this.log.debug("Not forwarding a client method", { method: blocked.method });
    // A request still gets its answer; a notification has none.
    if (blocked.id === undefined) return;
    const error = { code: METHOD_NOT_FOUND, message: `${blocked.method} is not available` };
    session.ws.send(JSON.stringify({ jsonrpc: "2.0", id: blocked.id, error }));
  }

  protected override handleServerFrame(session: WtLspSession, body: string): void {
    const status = readServerStatus(body);
    if (!status) {
      super.handleServerFrame(session, body);
      return;
    }
    if (status.notice) this.report(session, status.notice.kind, status.notice.message);
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
    if (!paths.some((changed) => isRustManifestPath(wtPath, changed))) return;
    const root = path.resolve(wtPath);
    for (const session of this.sessions.values()) {
      if (path.resolve(session.wtPath) !== root) continue;
      const state = this.states.get(session);
      if (!state) continue;
      const manifests = findRustManifests(session.wtPath);
      if (manifests.join("\0") !== state.manifests.join("\0"))
        this.restart(session, "manifests changed");
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
