import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  ConnectionState,
  IMessageTransport,
  JSONObject,
  JSONValue,
  Message,
  MessageListener,
} from "@hediet/json-rpc";
import { constValue, isRequestOrNotification } from "@hediet/json-rpc";
import type * as monaco from "monaco-editor";

import { fakeMonaco, fakeMonacoModule } from "../../testing/fake-monaco";

mock.module("monaco-editor", () => fakeMonacoModule);

const { MonacoLspClient } = await import("../LspClient");
// The fake module, typed as Monaco: its enum members read as their own names.
const { languages } = await import("monaco-editor");

const tick = (ms = 0) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

type RequestMessage = { id: number; method: string; params: unknown };
type Answer = { result: JSONValue } | { error: { code: number; message: string } } | "never";

/** The server side of an in-memory transport: records traffic and answers requests by method. */
class FakeServer implements IMessageTransport {
  readonly state = constValue<ConnectionState>({ state: "open" });
  readonly requests: RequestMessage[] = [];
  readonly notifications: Array<{ method: string; params: unknown }> = [];
  clientCapabilities: unknown;
  private _listener: MessageListener | undefined;

  constructor(
    private readonly _serverCapabilities: JSONObject,
    private readonly _answer: (request: RequestMessage) => Answer,
  ) {}

  setListener(listener: MessageListener | undefined): void {
    this._listener = listener;
  }

  async send(message: Message): Promise<void> {
    if (!isRequestOrNotification(message)) return;
    if (message.id === undefined) {
      this.notifications.push({ method: message.method, params: message.params });
      return;
    }
    const request = { id: Number(message.id), method: message.method, params: message.params };
    if (request.method === "initialize") {
      this.clientCapabilities = (message.params as { capabilities: unknown }).capabilities;
      this._reply(request.id, { result: { capabilities: this._serverCapabilities } });
      return;
    }
    this.requests.push(request);
    const answer = this._answer(request);
    if (answer !== "never") this._reply(request.id, answer);
  }

  toString(): string {
    return "FakeServer";
  }

  /** Sends a server-to-client request and waits for the client to handle it. */
  async request(method: string, params: JSONObject): Promise<void> {
    this._listener?.({ jsonrpc: "2.0", id: "server-1", method, params });
    await tick(5);
  }

  private _reply(id: number, answer: Exclude<Answer, "never">): void {
    // Answer on a later task, as a real server would.
    setTimeout(() => this._listener?.({ jsonrpc: "2.0", id, ...answer }), 0);
  }
}

function tokenSource() {
  let cancelled = false;
  const listeners = new Set<() => void>();
  const token: monaco.CancellationToken = {
    get isCancellationRequested() {
      return cancelled;
    },
    onCancellationRequested: (listener: () => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
  const cancel = () => {
    cancelled = true;
    for (const listener of [...listeners]) listener();
  };
  return { token, cancel };
}

const range = (line: number, start: number, end: number) => ({
  start: { line, character: start },
  end: { line, character: end },
});

async function connect(
  serverCapabilities: JSONObject,
  answer: (request: RequestMessage) => Answer,
) {
  const server = new FakeServer(serverCapabilities, answer);
  const client = new MonacoLspClient(server);
  // Let the initialize handshake complete.
  await tick(5);
  return { server, client };
}

describe("workspace symbols", () => {
  beforeEach(() => {
    fakeMonaco.reset();
  });

  test("declares the workspace symbol client capability with resolve support", async () => {
    const { server, client } = await connect({}, () => ({ result: null }));
    expect(server.clientCapabilities).toMatchObject({
      workspace: { symbol: { resolveSupport: { properties: ["location.range"] } } },
    });
    client.dispose();
  });

  test("returns no symbols and sends nothing when the server has no provider", async () => {
    const { server, client } = await connect({}, () => ({ result: [] }));
    expect(await client.workspaceSymbols("foo", tokenSource().token)).toEqual([]);
    expect(server.requests).toEqual([]);
    client.dispose();
  });

  test("converts SymbolInformation and WorkspaceSymbol results to Monaco terms", async () => {
    const { server, client } = await connect({ workspaceSymbolProvider: true }, () => ({
      result: [
        {
          name: "deactivate",
          kind: 6,
          containerName: "UserAccount",
          deprecated: true,
          location: { uri: "file:///w/models.py", range: range(1, 8, 18) },
        },
        { name: "Pending", kind: 5, containerName: "", location: { uri: "file:///w/p.py" } },
      ],
    }));

    const symbols = await client.workspaceSymbols("deact", tokenSource().token);

    expect(server.requests.map((r) => [r.method, r.params])).toEqual([
      ["workspace/symbol", { query: "deact" }],
    ]);
    expect(symbols).toEqual([
      {
        name: "deactivate",
        kind: languages.SymbolKind.Method,
        tags: [languages.SymbolTag.Deprecated],
        containerName: "UserAccount",
        uri: "file:///w/models.py",
        range: { startLineNumber: 2, startColumn: 9, endLineNumber: 2, endColumn: 19 },
      },
      {
        name: "Pending",
        kind: languages.SymbolKind.Class,
        tags: [],
        containerName: undefined,
        uri: "file:///w/p.py",
        range: undefined,
      },
    ]);
    client.dispose();
  });

  test("cancelling sends $/cancelRequest for the request's id and rejects at once", async () => {
    const { server, client } = await connect({ workspaceSymbolProvider: true }, () => "never");
    const tokens = tokenSource();

    const pending = client.workspaceSymbols("slow", tokens.token);
    await tick();
    tokens.cancel();

    await expect(pending).rejects.toThrow("Canceled");
    const [request] = server.requests;
    expect(server.notifications).toContainEqual({
      method: "$/cancelRequest",
      params: { id: request!.id },
    });
    client.dispose();
  });

  test("an already cancelled token sends no request", async () => {
    const { server, client } = await connect({ workspaceSymbolProvider: true }, () => ({
      result: [],
    }));
    const tokens = tokenSource();
    tokens.cancel();

    await expect(client.workspaceSymbols("x", tokens.token)).rejects.toThrow("Canceled");
    expect(server.requests).toEqual([]);
    client.dispose();
  });

  test("server errors reject with the server's message", async () => {
    const { client } = await connect({ workspaceSymbolProvider: true }, () => ({
      error: { code: -32603, message: "index not ready" },
    }));
    await expect(client.workspaceSymbols("x", tokenSource().token)).rejects.toThrow(
      "index not ready",
    );
    client.dispose();
  });

  test("resolves a symbol without a range through workspaceSymbol/resolve", async () => {
    const unresolved = { name: "Pending", kind: 5, location: { uri: "file:///w/p.py" }, data: 7 };
    const { server, client } = await connect(
      { workspaceSymbolProvider: { resolveProvider: true } },
      (request) =>
        request.method === "workspace/symbol"
          ? { result: [unresolved] }
          : {
              result: {
                ...unresolved,
                location: { uri: "file:///w/p.py", range: range(3, 6, 13) },
              },
            },
    );

    const [symbol] = await client.workspaceSymbols("pend", tokenSource().token);
    const resolved = await client.resolveWorkspaceSymbol(symbol!, tokenSource().token);

    expect(server.requests.at(-1)).toMatchObject({
      method: "workspaceSymbol/resolve",
      params: unresolved,
    });
    expect(resolved.range).toEqual({
      startLineNumber: 4,
      startColumn: 7,
      endLineNumber: 4,
      endColumn: 14,
    });
    client.dispose();
  });

  test("does not resolve symbols that have a range or when the server cannot resolve", async () => {
    const { server, client } = await connect({ workspaceSymbolProvider: true }, () => ({
      result: [
        { name: "A", kind: 5, location: { uri: "file:///w/a.py", range: range(0, 6, 7) } },
        { name: "B", kind: 5, location: { uri: "file:///w/b.py" } },
      ],
    }));

    const symbols = await client.workspaceSymbols("", tokenSource().token);
    for (const symbol of symbols) {
      expect(await client.resolveWorkspaceSymbol(symbol, tokenSource().token)).toBe(symbol);
    }
    expect(server.requests.map((r) => r.method)).toEqual(["workspace/symbol"]);
    client.dispose();
  });

  test("follows dynamic registration of the provider", async () => {
    const { server, client } = await connect({}, () => ({ result: [] }));
    await server.request("client/registerCapability", {
      registrations: [{ id: "ws", method: "workspace/symbol", registerOptions: {} }],
    });
    await client.workspaceSymbols("a", tokenSource().token);
    expect(server.requests.map((r) => r.method)).toContain("workspace/symbol");
    client.dispose();
  });
});
