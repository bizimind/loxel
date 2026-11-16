/**
 * The real ESLint language server, built by `build:language-servers eslint-language-server`, run
 * through `EslintLspManager` on a project using the ESLint this package installs. It is what proves
 * a bump of the server's tag or of the npm packages it bundles. CI builds the bundle first, so there
 * a missing bundle fails instead of skipping.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { ServerWebSocket } from "bun";

import { builtBinaryExists } from "@/test/built-binary";

const LOXEL = path.resolve(import.meta.dir, "../..");
const BUNDLE = path.join(LOXEL, "build/eslint-language-server/eslintServer.cjs");
const NODE = Bun.which("node");
/** A ceiling for a cold start on a loaded machine; each step awaits the server's own answer. */
const TEST_TIMEOUT_MS = 60_000;

const stateDir = mkdtempSync(path.join(tmpdir(), "eslint-server-state-"));
process.env.LOXEL_STATE_DIR = stateDir;
// Outside the suite, which does not run when it is skipped.
afterAll(() => {
  rmSync(stateDir, { recursive: true, force: true });
});
// The worktree's Node is the `node` on this PATH. A real resolution reads the login shell, which a
// test machine may set up differently, and a different answer later would restart the server.
void mock.module("./node-env", () => ({
  getNodeEnv: () => Promise.resolve({ env: { nodePath: NODE, version: null } }),
  subscribeNodeEnv: () => () => {},
}));

const { EslintLspManager } = await import("./eslint-lsp-manager");
const { setRepoTrusted } = await import("./repo-trust");

interface Range {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

interface Diagnostic {
  range: Range;
  code?: string | number;
}

interface WorkspaceEdit {
  documentChanges?: { textDocument: { uri: string }; edits: { newText: string }[] }[];
}

interface CodeAction {
  title: string;
  kind?: string;
  edit?: WorkspaceEdit;
  command?: { command: string; arguments?: unknown[] };
}

interface Frame {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

/** A window's side of the socket: sends requests, hears answers, and applies the server's edits. */
class Client {
  readonly ws: ServerWebSocket<unknown>;
  private nextId = 1;
  private readonly answers = new Map<number | string, PromiseWithResolvers<Frame>>();
  private readonly edits: WorkspaceEdit[] = [];
  /** Why the manager closed the socket, which fails every request instead of leaving it waiting. */
  private closed: Error | null = null;

  constructor(private readonly manager: InstanceType<typeof EslintLspManager>) {
    this.ws = {
      send: (data: string) => {
        this.receive(JSON.parse(data) as Frame);
        return data.length;
      },
      close: (code?: number, reason?: string) => {
        this.closed = new Error(`The manager closed the socket (${code}): ${reason}`);
        for (const answer of this.answers.values()) answer.reject(this.closed);
      },
    } as unknown as ServerWebSocket<unknown>;
  }

  async request<T>(method: string, params: unknown): Promise<T> {
    if (this.closed) throw this.closed;
    const id = this.nextId++;
    const answer = Promise.withResolvers<Frame>();
    this.answers.set(id, answer);
    this.send({ id, method, params });
    const { result, error } = await answer.promise;
    if (error) throw new Error(`${method} failed: ${JSON.stringify(error)}`);
    return result as T;
  }

  notify(method: string, params: unknown): void {
    this.send({ method, params });
  }

  /**
   * Runs an action's command and returns the edit the server asked the window to apply, which it
   * does before it answers the command.
   */
  async runCommand(action: CodeAction | undefined): Promise<WorkspaceEdit> {
    if (!action?.command) throw new Error(`Not a command: ${JSON.stringify(action)}`);
    this.edits.length = 0;
    await this.request("workspace/executeCommand", action.command);
    const [edit] = this.edits;
    if (!edit) throw new Error(`${action.command.command} applied no edit`);
    return edit;
  }

  private send(message: Frame): void {
    this.manager.handleMessage(this.ws, JSON.stringify({ jsonrpc: "2.0", ...message }));
  }

  private receive(frame: Frame): void {
    if (frame.id === undefined) return;
    if (!frame.method) {
      this.answers.get(frame.id)?.resolve(frame);
      return;
    }
    if (frame.method === "workspace/applyEdit") {
      this.edits.push((frame.params as { edit: WorkspaceEdit }).edit);
      this.send({ id: frame.id, result: { applied: true } });
      return;
    }
    this.send({ id: frame.id, result: null });
  }
}

/** What the app's client (`@bizimind/monaco-lsp-client`) advertises for these features. */
const CAPABILITIES = {
  textDocument: {
    publishDiagnostics: {
      relatedInformation: true,
      versionSupport: true,
      codeDescriptionSupport: true,
      dataSupport: true,
    },
    diagnostic: { dynamicRegistration: true, relatedDocumentSupport: true },
    codeAction: {
      dynamicRegistration: true,
      codeActionLiteralSupport: {
        codeActionKind: { valueSet: ["quickfix", "refactor", "source", "source.fixAll"] },
      },
      isPreferredSupport: true,
      disabledSupport: true,
      dataSupport: true,
      resolveSupport: { properties: ["edit"] },
    },
  },
  workspace: {
    applyEdit: true,
    configuration: true,
    executeCommand: { dynamicRegistration: true },
    diagnostics: { refreshSupport: true },
    workspaceEdit: { documentChanges: true },
  },
};

const SOURCE = "var a = 1;\nconsole.log(a);\n";

// Without Node it still runs in CI, where that is a failure to see.
const canRun = Boolean(NODE ?? process.env.CI) && (await builtBinaryExists(BUNDLE));

describe.skipIf(!canRun)("the ESLint language server", () => {
  let wt = "";
  let manager: InstanceType<typeof EslintLspManager> | undefined;
  let client: Client;
  let uri: string;
  let diagnostics: Diagnostic[];

  /** The new text of each edit `edit` makes to the fixture's file. */
  const newTexts = (edit: WorkspaceEdit | undefined) =>
    (edit?.documentChanges ?? [])
      .filter((change) => change.textDocument.uri === uri)
      .flatMap((change) => change.edits.map((e) => e.newText));

  const pullDiagnostics = async () =>
    (
      await client.request<{ items: Diagnostic[] }>("textDocument/diagnostic", {
        textDocument: { uri },
      })
    ).items;

  const codeActions = (range: Range | undefined, context: object) =>
    client.request<CodeAction[]>("textDocument/codeAction", {
      textDocument: { uri },
      range,
      context,
    });

  beforeAll(async () => {
    if (!NODE) throw new Error("No node on PATH to run the ESLint language server");
    if (!existsSync(BUNDLE)) {
      throw new Error(
        `Missing ${BUNDLE}: run pnpm -C packages/loxel run build:language-servers eslint-language-server`,
      );
    }
    wt = realpathSync(mkdtempSync(path.join(tmpdir(), "eslint-server-wt-")));
    mkdirSync(path.join(wt, "src"));
    mkdirSync(path.join(wt, "node_modules"));
    // This package's ESLint, whose dependencies sit beside it in pnpm's store.
    symlinkSync(
      realpathSync(path.join(LOXEL, "node_modules/eslint")),
      path.join(wt, "node_modules/eslint"),
      "junction",
    );
    writeFileSync(
      path.join(wt, "package.json"),
      JSON.stringify({ name: "fixture", private: true, devDependencies: { eslint: "*" } }),
    );
    writeFileSync(
      path.join(wt, "eslint.config.js"),
      'module.exports = [{ rules: { "no-var": "error" } }];\n',
    );
    const file = path.join(wt, "src/a.js");
    writeFileSync(file, SOURCE);
    setRepoTrusted(wt, true);

    manager = new EslintLspManager();
    client = new Client(manager);
    manager.createSession(client.ws, wt);
    await client.request("initialize", {
      processId: null,
      rootUri: null,
      capabilities: CAPABILITIES,
    });
    client.notify("initialized", {});
    uri = pathToFileURL(file).href.replace("file:///", "loxel://HEAD/");
    client.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: "javascript", version: 1, text: SOURCE },
    });
    diagnostics = await pullDiagnostics();
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await manager?.destroy();
    if (wt) rmSync(wt, { recursive: true, force: true });
  });

  test("lints with the project's config", () => {
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["no-var"]);
    expect(diagnostics[0]?.range.start).toEqual({ line: 0, character: 0 });
  });

  test(
    "fixes the problem, and disables its rule for the line",
    async () => {
      const actions = await codeActions(diagnostics[0]?.range, { diagnostics });
      const byCommand = (command: string) =>
        actions.find((action) => action.command?.command === command);

      expect(newTexts(await client.runCommand(byCommand("eslint.applySingleFix")))).toEqual([
        "let a = 1;",
      ]);
      expect(newTexts(await client.runCommand(byCommand("eslint.applyDisableLine")))).toEqual([
        "// eslint-disable-next-line no-var\n",
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "fixes the whole file",
    async () => {
      const actions = await codeActions(
        { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        { diagnostics: [], only: ["source.fixAll.eslint"] },
      );
      expect(actions.map((action) => action.kind)).toEqual(["source.fixAll.eslint"]);
      expect(newTexts(actions[0]?.edit)).toEqual(["let"]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "lints the text as it is edited",
    async () => {
      client.notify("textDocument/didChange", {
        textDocument: { uri, version: 2 },
        contentChanges: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
            text: "let",
          },
        ],
      });
      expect(await pullDiagnostics()).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});
