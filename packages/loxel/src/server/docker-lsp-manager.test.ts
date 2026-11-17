import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { ServerWebSocket } from "bun";

import { builtBinaryExists } from "@/test/built-binary";

import { DockerLspManager } from "./docker-lsp-manager";

// The server that ships, built by `pnpm run build:language-servers dockerfile-language-server`.
const BUILT_SERVER = resolve(import.meta.dir, "../../build/docker-langserver");

interface Diagnostic {
  message: string;
  source?: string;
}

interface Frame {
  id?: number | string;
  method?: string;
  params?: { uri?: string; diagnostics?: Diagnostic[] };
  result?: unknown;
  error?: unknown;
}

/** Stands in for the WebSocket and the Monaco LSP client behind it. */
class FakeClient {
  readonly ws: ServerWebSocket<unknown>;
  private readonly frames: Frame[] = [];
  private readonly listeners = new Set<() => void>();
  private nextId = 1;

  constructor(private readonly manager: DockerLspManager) {
    const ws = {
      send: (data: string) => {
        this.frames.push(JSON.parse(data) as Frame);
        for (const listener of this.listeners) listener();
        return data.length;
      },
      close: () => {},
    };
    this.ws = ws as unknown as ServerWebSocket<unknown>;
  }

  send(message: Record<string, unknown>): void {
    this.manager.handleMessage(this.ws, JSON.stringify({ jsonrpc: "2.0", ...message }));
  }

  /** The first frame `matches` takes, from those received or the next to arrive. */
  frame(matches: (candidate: Frame) => boolean): Promise<Frame> {
    return new Promise((resolveFrame) => {
      const check = () => {
        const found = this.frames.find(matches);
        if (!found) return;
        this.listeners.delete(check);
        resolveFrame(found);
      };
      this.listeners.add(check);
      check();
    });
  }

  async request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    this.send({ id, method, params });
    const reply = await this.frame((candidate) => candidate.id === id && !candidate.method);
    if (reply.error) throw new Error(`${method} failed: ${JSON.stringify(reply.error)}`);
    return reply.result;
  }

  /** The diagnostics published for `uri` after the frames already received. */
  nextDiagnostics(uri: string): Promise<Diagnostic[]> {
    const seen = this.frames.length;
    return this.frame(
      (candidate) =>
        this.frames.indexOf(candidate) >= seen &&
        candidate.method === "textDocument/publishDiagnostics" &&
        candidate.params?.uri === uri,
    ).then((candidate) => candidate.params?.diagnostics ?? []);
  }
}

describe.skipIf(!(await builtBinaryExists(BUILT_SERVER)))(
  "DockerLspManager with the built docker-langserver",
  () => {
    let wt: string;
    let manager: DockerLspManager;
    let client: FakeClient;
    let capabilities: Record<string, unknown>;

    beforeAll(async () => {
      wt = await realpath(await mkdtemp(join(tmpdir(), "docker-lsp-")));
      manager = new DockerLspManager();
      client = new FakeClient(manager);
      manager.createSession(client.ws, wt);
      // What Monaco's client declares that the server reads.
      const result = (await client.request("initialize", {
        processId: null,
        capabilities: {
          workspace: { applyEdit: true, workspaceEdit: { documentChanges: true } },
          textDocument: {
            hover: { contentFormat: ["markdown", "plaintext"] },
            completion: { completionItem: { snippetSupport: true } },
            semanticTokens: {},
          },
        },
      })) as { capabilities: Record<string, unknown> };
      capabilities = result.capabilities;
      client.send({ method: "initialized", params: {} });
    });

    afterAll(async () => {
      manager.destroy();
      await rm(wt, { recursive: true, force: true });
    });

    let documents = 0;
    /** Opens a new Dockerfile with `text` and returns its URI and first diagnostics. */
    async function open(text: string): Promise<{ uri: string; diagnostics: Diagnostic[] }> {
      documents += 1;
      const uri = pathToFileURL(join(wt, `Dockerfile.${documents}`)).href;
      const diagnostics = client.nextDiagnostics(uri);
      client.send({
        method: "textDocument/didOpen",
        params: { textDocument: { uri, languageId: "dockerfile", version: 1, text } },
      });
      return { uri, diagnostics: await diagnostics };
    }

    test("advertises the Dockerfile features", () => {
      expect(capabilities).toMatchObject({
        completionProvider: expect.any(Object),
        hoverProvider: true,
        documentFormattingProvider: true,
        documentSymbolProvider: true,
        codeActionProvider: true,
      });
      expect(capabilities).not.toHaveProperty("semanticTokensProvider");
    });

    test("reports dockerfile-utils' local checks as diagnostics", async () => {
      const { diagnostics } = await open('FROM alpine\nMAINTAINER me\nCMD ["a"]\nCMD ["b"]\n');
      expect(diagnostics.map(({ source }) => source)).toEqual(
        expect.arrayContaining(["dockerfile-utils"]),
      );
      expect(diagnostics.map(({ message }) => message).join("\n")).toContain(
        "There can only be one CMD instruction",
      );
    });

    test("applies incremental changes", async () => {
      const { uri } = await open("FROM alpine\nRUN echo hi\n");
      const diagnostics = client.nextDiagnostics(uri);
      // Replaces `RUN` with `run`, which the server flags by its casing.
      client.send({
        method: "textDocument/didChange",
        params: {
          textDocument: { uri, version: 2 },
          contentChanges: [
            {
              range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } },
              text: "run",
            },
          ],
        },
      });
      // Exactly that: a server that took the fragment for the whole file would also miss its FROM.
      expect((await diagnostics).map(({ message }) => message)).toEqual([
        "Instructions should be written in uppercase letters",
      ]);
    });

    test("completes instructions", async () => {
      const { uri } = await open("FROM alpine\n");
      const items = (await client.request("textDocument/completion", {
        textDocument: { uri },
        position: { line: 1, character: 0 },
      })) as { label: string }[];
      expect(items.map(({ label }) => label)).toEqual(
        expect.arrayContaining(["RUN command", "COPY source dest"]),
      );
    });

    test("answers an image tag completion without asking Docker Hub", async () => {
      const { uri } = await open("FROM alpine:3\n");
      const items = await client.request("textDocument/completion", {
        textDocument: { uri },
        position: { line: 0, character: 13 },
      });
      expect(items).toEqual([]);
    });

    test("hovers an instruction", async () => {
      const { uri } = await open("FROM alpine\nRUN echo hi\n");
      const hover = await client.request("textDocument/hover", {
        textDocument: { uri },
        position: { line: 1, character: 1 },
      });
      expect(JSON.stringify(hover)).toContain("Execute any commands");
    });

    test("formats", async () => {
      const { uri } = await open("FROM alpine\n   RUN echo hi\n");
      const edits = (await client.request("textDocument/formatting", {
        textDocument: { uri },
        options: { tabSize: 4, insertSpaces: true },
      })) as { newText: string; range: { start: { line: number } } }[];
      expect(edits).toEqual([expect.objectContaining({ newText: "" })]);
      expect(edits[0]?.range.start.line).toBe(1);
    });

    test("lists document symbols", async () => {
      const { uri } = await open("FROM alpine AS build\nRUN echo hi\n");
      const symbols = (await client.request("textDocument/documentSymbol", {
        textDocument: { uri },
      })) as { name: string }[];
      expect(symbols.map(({ name }) => name)).toEqual(["FROM", "RUN"]);
    });
  },
);
