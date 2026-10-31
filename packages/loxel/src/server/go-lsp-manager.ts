import path from "node:path";

import { isRecord } from "@/lib/is-record";

import { pathOutsideWorktree } from "./python-env";
import { buildSpawnEnv, refreshLoginShellEnv } from "./shell-env";
import {
  type SpawnOptions,
  WorktreeLspManager,
  type WtLspContext,
  type WtLspSession,
} from "./stdio-lsp-manager";

const GOPLS = process.platform === "win32" ? "gopls.exe" : "gopls";

/**
 * Set in gopls's environment: Loxel works from what is on the machine, and the user downloads
 * modules and toolchains from a terminal. Without the last two, `go` still reaches the checksum
 * database for a module with no `go.sum` entry and hosts named by `GOPRIVATE` directly.
 */
export const GO_ENV = { GOPROXY: "off", GOTOOLCHAIN: "local", GOSUMDB: "off", GONOPROXY: "none" };

/** What the user is told when `go` is missing. */
export const GO_NOT_FOUND_REASON =
  "Go is not installed or not on your PATH. Install Go, then restart the server.";

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
      message: `This project needs Go ${needed}, and the Go on your PATH is ${running}. Loxel does not install Go toolchains: install Go ${needed}, ${RESTART}`,
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

/** The login-shell PATH without the worktree's directories, which `go` and gopls run tools from. */
function goPath(wtPath: string): string {
  return pathOutsideWorktree(buildSpawnEnv().PATH ?? "", wtPath);
}

export interface GoSetupProblem {
  kind: "newer-go" | "missing-module" | "command-needs-module";
  message: string;
}

/**
 * Manages gopls (`gopls serve`) child processes, one per worktree. gopls runs `go` for everything
 * it knows about a project, so a session starts only where `go` is found.
 */
export class GoLspManager extends WorktreeLspManager {
  protected override readonly forwardWatchedFiles = true;
  /** What each session has told the user already. */
  private readonly reported = new WeakMap<WtLspSession, Set<string>>();
  /** Worktrees last told to install a newer Go, which may be in a directory new to the PATH. */
  private readonly waitingForNewerGo = new Set<string>();

  constructor() {
    super("go-lsp");
  }

  protected async resolveBinary(context: WtLspContext): Promise<string | null> {
    if (this.waitingForNewerGo.delete(context.wtPath)) await refreshLoginShellEnv();
    if (!goOnPath(context.wtPath)) {
      // It may have been installed since the login-shell PATH was captured.
      await refreshLoginShellEnv();
      if (!goOnPath(context.wtPath)) return null;
    }
    return this.resolveBundledBinary(GOPLS, path.resolve(import.meta.dir, "../../build", GOPLS));
  }

  protected override serverFailureReason(context: WtLspContext): string | null {
    return goOnPath(context.wtPath) ? null : GO_NOT_FOUND_REASON;
  }

  protected override spawnArgs(): readonly string[] {
    return ["serve"];
  }

  protected override spawnOptions(context: WtLspContext): SpawnOptions {
    return { cwd: context.wtPath, env: { PATH: goPath(context.wtPath), ...GO_ENV } };
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

function goOnPath(wtPath: string): boolean {
  return Bun.which("go", { PATH: goPath(wtPath) }) !== null;
}
