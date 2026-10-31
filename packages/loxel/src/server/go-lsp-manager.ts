import { statSync } from "node:fs";
import path from "node:path";

import type { ServerWebSocket, Subprocess } from "bun";

import { GO_NOT_FOUND, type GoEnv } from "@/api/go-env-model";
import { LSP_RESTART_CLOSE_CODE } from "@/api/ws-protocol";
import { isRecord } from "@/lib/is-record";

import {
  GO,
  getGoEnv,
  GOPLS,
  goSpawnEnv,
  goToolPath,
  refreshGoEnv,
  subscribeGoEnv,
} from "./go-env";
import { getGoChoice } from "./go-toolchain-store";
import { buildSpawnEnv, refreshLoginShellEnv } from "./shell-env";
import {
  type SpawnOptions,
  WorktreeLspManager,
  type WtLspContext,
  type WtLspSession,
} from "./stdio-lsp-manager";

/** What the user is told when `go` is missing. */
export const GO_NOT_FOUND_REASON = `${GO_NOT_FOUND}. Install Go, then restart the server.`;

/** Answered for the `gopls` section of `workspace/configuration`. */
export const GOPLS_SETTINGS = {
  // Go to Symbol lists the project's own symbols; definitions still reach everything else.
  symbolScope: "workspace",
  // Its default prompts for, and can run, a check against an online database.
  vulncheck: "Off",
  usePlaceholders: true,
  semanticTokens: true,
  // TextMate highlights these better; the others are what only the type checker knows.
  semanticTokenTypes: { comment: false, string: false, number: false, operator: false },
  hints: {
    assignVariableTypes: true,
    compositeLiteralFields: false,
    compositeLiteralTypes: false,
    constantValues: true,
    functionTypeParameters: true,
    ignoredError: false,
    parameterNames: true,
    rangeVariableTypes: true,
  },
  codelenses: {
    tidy: true,
    vendor: true,
    // Upgrades are looked up online, which gopls's environment rules out.
    upgrade_dependency: false,
    // These run with no visible output, since Loxel declares no progress support.
    generate: false,
    regenerate_cgo: false,
    run_govulncheck: false,
    // Nothing in Loxel runs tests from a lens.
    test: false,
  },
};

/**
 * Code actions that start a local web page and announce it with `window/showDocument` or an info
 * `window/showMessage`, which Loxel does not show, so they would look dead.
 */
const HIDDEN_ACTION_KINDS: ReadonlySet<string> = new Set([
  "gopls.doc.features",
  "source.assembly",
  "source.doc",
  "source.freesymbols",
  "source.splitPackage",
]);

/**
 * The commands behind {@link HIDDEN_ACTION_KINDS}, and those that look up modules online (`go get`
 * quick fixes, upgrades), which gopls's environment rules out.
 */
const HIDDEN_COMMANDS: ReadonlySet<string> = new Set([
  "gopls.add_dependency",
  "gopls.assembly",
  "gopls.check_upgrades",
  "gopls.doc",
  "gopls.free_symbols",
  "gopls.go_get_package",
  "gopls.run_govulncheck",
  "gopls.split_package",
  "gopls.upgrade_dependency",
  "gopls.vulncheck",
]);

/** Cheap test before parsing a frame: every frame to scrub holds one of these as a JSON string. */
const HIDDEN_FRAME = new RegExp(
  `"(?:${[...HIDDEN_ACTION_KINDS, ...HIDDEN_COMMANDS].join("|").replaceAll(".", "\\.")})"`,
);

function isHiddenAction(item: unknown): boolean {
  if (!isRecord(item)) return false;
  if (typeof item.kind === "string" && HIDDEN_ACTION_KINDS.has(item.kind)) return true;
  // A `CodeAction` holds its command, a bare `Command` is one.
  const command = isRecord(item.command) ? item.command.command : item.command;
  return typeof command === "string" && HIDDEN_COMMANDS.has(command);
}

function parseFrame(body: string): Record<string, unknown> | null {
  try {
    const frame: unknown = JSON.parse(body);
    return isRecord(frame) ? frame : null;
  } catch {
    return null;
  }
}

/** The server's frame with the hidden actions taken out of its capabilities and code actions. */
export function withoutHiddenActions(body: string): string {
  if (!HIDDEN_FRAME.test(body)) return body;
  const frame = parseFrame(body);
  if (!frame) return body;
  const { result } = frame;
  if (Array.isArray(result)) {
    frame.result = result.filter((item) => !isHiddenAction(item));
  } else if (isRecord(result) && isRecord(result.capabilities)) {
    const { codeActionProvider, executeCommandProvider } = result.capabilities;
    if (isRecord(codeActionProvider) && Array.isArray(codeActionProvider.codeActionKinds)) {
      codeActionProvider.codeActionKinds = codeActionProvider.codeActionKinds.filter(
        (kind) => !HIDDEN_ACTION_KINDS.has(kind),
      );
    }
    if (isRecord(executeCommandProvider) && Array.isArray(executeCommandProvider.commands)) {
      executeCommandProvider.commands = executeCommandProvider.commands.filter(
        (command) => !HIDDEN_COMMANDS.has(command),
      );
    }
  }
  return JSON.stringify(frame);
}

/** LSP `MessageType.Warning`. */
const MESSAGE_TYPE_WARNING = 2;

/** Finds a kind of problem in a frame's text; a capture group holds what the message names. */
const NEWER_GO = /requires go >= (\S+) \(running go (\S+); GOTOOLCHAIN=local\)/;
const MISSING_MODULE = /could not import (\S+) \(no required module provides package/;
const LOOKUP_FAILED = /module lookup disabled by GOPROXY=off|missing go\.sum entry/;

/** Cheap test before parsing a frame: every frame with a problem to report holds one of these. */
const PROBLEM_FRAME =
  /GOTOOLCHAIN=local\)|no required module provides package|lookup disabled|missing go\.sum entry/;

const RESTART = "then run Restart Language Servers.";

/**
 * What to tell the user about a frame from gopls, when it reports something they can fix from a
 * terminal: gopls's own words are spread over diagnostics and log-level messages, and do not say
 * what to run.
 */
export function goSetupProblem(body: string): GoSetupProblem | null {
  if (!PROBLEM_FRAME.test(body)) return null;
  const frame = parseFrame(body);
  if (!frame) return null;
  // A command the user ran fails with an error response, a workspace load with the other two.
  const isProblem =
    isRecord(frame.error) ||
    frame.method === "window/showMessage" ||
    frame.method === "textDocument/publishDiagnostics";
  if (!isProblem) return null;
  // Without gopls's escapes of `<`, `>` and `&`.
  const text = JSON.stringify(frame);

  const newerGo = NEWER_GO.exec(text);
  if (newerGo) {
    const [, needed, running] = newerGo;
    return {
      kind: "newer-go",
      message: `This project needs Go ${needed}, and the Go in use is ${running}. Loxel does not download Go toolchains. Run \`go version\` in the project from a terminal to download it, or put Go ${needed} on your PATH, and automatic detection finds it and restarts gopls.`,
    };
  }
  if (isRecord(frame.error)) {
    if (!LOOKUP_FAILED.test(text)) return null;
    return {
      kind: "command-needs-module",
      message: `That command needs modules that are not in the module cache. Loxel does not download modules: run \`go mod download\` in a terminal, ${RESTART}`,
    };
  }
  const missing = MISSING_MODULE.exec(text);
  if (!missing && !LOOKUP_FAILED.test(text)) return null;
  const what = missing ? `the module of ${missing[1]} is` : "some modules are";
  return {
    kind: "missing-module",
    message: `Imports cannot be resolved: ${what} not in the module cache. Loxel does not download modules: run \`go mod download\` in a terminal (\`go get\` for a new dependency), ${RESTART}`,
  };
}

export interface GoSetupProblem {
  kind: "newer-go" | "missing-module" | "command-needs-module";
  message: string;
}

/** A gopls binary, and what tells a reinstall at the same path. */
interface GoplsPick {
  path: string;
  stamp: string;
}

function fileStamp(file: string): string {
  try {
    const info = statSync(file);
    return `${info.dev}:${info.ino}:${info.mtimeMs}:${info.size}`;
  } catch {
    return "";
  }
}

/** What a gopls session was started with, which a restart follows. */
interface GoplsRun {
  go: Pick<GoEnv, "binary" | "source" | "version" | "goroot"> | null;
  gopls: GoplsPick;
}

function isSameRun(a: GoplsRun, b: GoplsRun): boolean {
  return (
    a.go?.binary === b.go?.binary &&
    a.go?.source === b.go?.source &&
    a.go?.version === b.go?.version &&
    a.go?.goroot === b.go?.goroot &&
    a.gopls.path === b.gopls.path &&
    a.gopls.stamp === b.gopls.stamp
  );
}

interface SessionWatch {
  run: GoplsRun | null;
  unsubscribe: () => void;
  /** One check at a time, so the last resolution decides. */
  checking: Promise<void>;
}

/**
 * Manages gopls (`gopls serve`) child processes, one per worktree. gopls runs `go` for everything
 * it knows about a project, so a session starts only where `go` is found, and restarts when the
 * worktree's `go` or the gopls to use changes, which it does not notice by itself.
 */
export class GoLspManager extends WorktreeLspManager {
  protected override readonly forwardWatchedFiles = true;
  /** What each session has told the user already. */
  private readonly reported = new WeakMap<WtLspSession, Set<string>>();
  /** Worktrees last told to install a newer Go, which may be in a directory new to the PATH. */
  private readonly waitingForNewerGo = new Set<string>();
  /** Starts that found no usable `go`. */
  private readonly withoutGo = new WeakSet<WtLspContext>();
  /** What each start runs, from `resolveBinary` on. */
  private readonly spawned = new WeakMap<WtLspContext, GoplsRun>();
  private readonly watches = new WeakMap<WtLspSession, SessionWatch>();

  constructor() {
    super("go-lsp");
  }

  protected async resolveBinary(context: WtLspContext): Promise<string | null> {
    const { wtPath } = context;
    if (this.waitingForNewerGo.delete(wtPath)) await refreshLoginShellEnv();
    let env = await getGoEnv(wtPath);
    if (!env) {
      // It may have been installed since the login-shell PATH was captured.
      await refreshLoginShellEnv();
      refreshGoEnv(wtPath);
      env = await getGoEnv(wtPath);
    }
    if (!env) {
      this.withoutGo.add(context);
      return null;
    }
    const gopls = this.pick(env);
    if (gopls) this.spawned.set(context, { go: env, gopls });
    return gopls?.path ?? null;
  }

  protected override serverFailureReason(context: WtLspContext): string | null {
    const { wtPath } = context;
    // A chosen Go need not be on the PATH at all; one that is gone is in `withoutGo` if nothing else is.
    const found = getGoChoice(wtPath) !== null || Bun.which(GO, { PATH: goToolPath(wtPath) });
    return found && !this.withoutGo.has(context) ? null : GO_NOT_FOUND_REASON;
  }

  protected override spawnArgs(): readonly string[] {
    return ["serve"];
  }

  protected override spawnOptions(context: WtLspContext): SpawnOptions {
    const go = this.spawned.get(context)?.go ?? null;
    return { cwd: context.wtPath, env: goSpawnEnv(context.wtPath, go) };
  }

  protected override buildSession(
    ws: ServerWebSocket<unknown>,
    proc: Subprocess,
    context: WtLspContext,
  ): WtLspSession {
    const session = super.buildSession(ws, proc, context);
    const { wtPath } = context;
    const watch: SessionWatch = {
      run: this.spawned.get(context) ?? null,
      unsubscribe: subscribeGoEnv(wtPath, ({ env }) => {
        watch.checking = watch.checking.then(() => this.restartIfChanged(session, watch, env));
      }),
      checking: Promise.resolve(),
    };
    this.watches.set(session, watch);
    // A change that landed while the binary was picked and spawned was heard by no one.
    watch.checking = getGoEnv(wtPath).then((env) => this.restartIfChanged(session, watch, env));
    return session;
  }

  protected override onSessionClosed(session: WtLspSession): void {
    this.watches.get(session)?.unsubscribe();
    this.watches.delete(session);
  }

  /** The user's gopls, or the bundled one when they have none. */
  private pick(env: GoEnv): GoplsPick | null {
    const dev = path.resolve(import.meta.dir, "../../build", GOPLS);
    const bundled = this.resolveBundledBinary(GOPLS, dev);
    // With nothing bundled that is the first on the plain PATH, which `env.gopls` already refused.
    const onPlainPath = bundled === Bun.which(GOPLS, { PATH: buildSpawnEnv().PATH ?? "" });
    const binary = env.gopls ?? (onPlainPath ? null : bundled);
    return binary ? { path: binary, stamp: fileStamp(binary) } : null;
  }

  /**
   * Restart the session's gopls when the worktree's `go` or the gopls to use changed: it does not
   * recover by itself from a newer Go appearing, and keeps analyzing with what it first saw.
   */
  private restartIfChanged(session: WtLspSession, watch: SessionWatch, env: GoEnv | null): void {
    if (!watch.run || !this.isSessionLive(session)) return;
    if (!env) {
      // Gone may be an install in progress, so the running gopls keeps serving. But a `go` still
      // there was refused, and gopls would find it: the restart stops it with the reason.
      if (Bun.which(GO, { PATH: goSpawnEnv(session.wtPath, null).PATH })) this.restart(session);
      return;
    }
    // Not answering may be an install in progress too; the status item says so meanwhile.
    if (!env.version) return;
    const gopls = this.pick(env);
    if (!gopls) return;
    const next = { go: env, gopls };
    if (isSameRun(watch.run, next)) return;
    this.log.info("Restarting gopls for a different go or gopls", {
      wtPath: session.wtPath,
      from: { go: watch.run.go?.version, gopls: watch.run.gopls.path },
      to: { go: env.version, gopls: gopls.path },
    });
    this.restart(session);
  }

  private restart({ ws }: WtLspSession): void {
    this.detach(ws);
    ws.close(LSP_RESTART_CLOSE_CODE, "go or gopls changed; reconnect");
  }

  // gopls does not finish loading a workspace until this request is answered, whatever the section.
  protected override async workspaceConfiguration(
    _session: WtLspSession,
    section: string | undefined,
  ): Promise<unknown> {
    return section === "gopls" ? GOPLS_SETTINGS : {};
  }

  protected override handleServerFrame(session: WtLspSession, body: string): void {
    super.handleServerFrame(session, withoutHiddenActions(body));
    const problem = goSetupProblem(body);
    if (problem) this.report(session, problem);
  }

  /** Tell the user, through the client's `showMessages`, once per session and problem. */
  private report(session: WtLspSession, { kind, message }: GoSetupProblem): void {
    const reported = this.reported.get(session) ?? new Set();
    this.reported.set(session, reported);
    if (kind === "newer-go") this.waitingForNewerGo.add(session.wtPath);
    if (reported.has(kind)) return;
    reported.add(kind);
    const params = { type: MESSAGE_TYPE_WARNING, message };
    session.ws.send(JSON.stringify({ jsonrpc: "2.0", method: "window/showMessage", params }));
  }
}
