import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import type { ServerWebSocket } from "bun";

import type { ClangdLspManager } from "./clangd-lsp-manager";

/** Just enough of a language client to start the server and wait for a file's diagnostics. */
export class FakeClient {
  readonly ws: ServerWebSocket<unknown>;
  /** The `window/showMessage` texts the server has sent, for the app to show. */
  readonly shownMessages: string[] = [];
  /** The socket's close, for a server that never starts. */
  readonly closed: Promise<{ code?: number; reason?: string }>;
  private nextId = 1;
  private readonly responses = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (reason: Error) => void }
  >();
  private readonly diagnosticsWaiters = new Map<string, (diagnostics: unknown[]) => void>();

  constructor(private readonly server: ClangdLspManager) {
    const { promise, resolve } = Promise.withResolvers<{ code?: number; reason?: string }>();
    this.closed = promise;
    const ws = {
      send: (data: string) => {
        this.receive(data);
        return data.length;
      },
      close: (code?: number, reason?: string) => {
        resolve({ code, reason });
        // Nothing would answer them now, and a test waiting on one should fail at once.
        for (const pending of this.responses.values()) {
          pending.reject(new Error(`Closed with ${code}: ${reason}`));
        }
        this.responses.clear();
      },
    };
    this.ws = ws as unknown as ServerWebSocket<unknown>;
  }

  async start(
    wtPath: string,
    capabilities: Record<string, unknown> = {},
  ): Promise<{ capabilities: Record<string, unknown> }> {
    this.server.createSession(this.ws, wtPath);
    const result = await this.request("initialize", { processId: null, capabilities });
    this.send({ method: "initialized", params: {} });
    return result as { capabilities: Record<string, unknown> };
  }

  /** Open a file and wait until clangd has built it and sent its diagnostics. */
  async openAndWaitForDiagnostics(file: string): Promise<unknown[]> {
    const uri = pathToFileURL(file).href;
    const published = new Promise<unknown[]>((resolve) => {
      this.diagnosticsWaiters.set(uri, resolve);
    });
    const text = await readFile(file, "utf8");
    this.send({
      method: "textDocument/didOpen",
      params: { textDocument: { uri, languageId: "cpp", version: 1, text } },
    });
    return published;
  }

  /** The next diagnostics clangd publishes for an open file; set up before causing them. */
  nextDiagnostics(file: string): Promise<unknown[]> {
    return new Promise((resolve) => {
      this.diagnosticsWaiters.set(pathToFileURL(file).href, resolve);
    });
  }

  /** Ask clangd to shut down, and wait for its answer. */
  async shutdown(): Promise<void> {
    await this.request("shutdown", null);
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.responses.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }

  send(message: Record<string, unknown>): void {
    this.server.handleMessage(this.ws, JSON.stringify({ jsonrpc: "2.0", ...message }));
  }

  private receive(data: string): void {
    const message = JSON.parse(data) as {
      id?: number;
      method?: string;
      params?: { uri?: string; diagnostics?: unknown[]; message?: string };
      result?: unknown;
    };
    if (message.method === "window/showMessage" && message.params?.message) {
      this.shownMessages.push(message.params.message);
      return;
    }
    if (message.method === "textDocument/publishDiagnostics" && message.params?.uri) {
      this.diagnosticsWaiters.get(message.params.uri)?.(message.params.diagnostics ?? []);
      return;
    }
    if (message.id !== undefined && !message.method) {
      this.responses.get(message.id)?.resolve(message.result);
    }
  }
}
