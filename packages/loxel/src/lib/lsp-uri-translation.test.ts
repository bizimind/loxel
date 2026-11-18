import { describe, expect, test } from "bun:test";

import { toServerId } from "@/api/worktree-ref";

import { editorFileUri } from "./live-editor-model";
import { type LspTransport, lspUriTranslation, translateLspUris } from "./lsp-uri-translation";

const SERVER = toServerId("0b9f6c1e-5b1a-4c55-9a43-2f1d8f0e7a10");
const { toServer, toClient } = lspUriTranslation(SERVER);

/** Editor model URIs, as monaco-lsp-client prints them (`Uri.toString()`). */
const file = (path: string) => editorFileUri({ server: SERVER, path }, "file").toString();
const loxel = (path: string) => editorFileUri({ server: SERVER, path }, "loxel").toString();

const range = { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } };

describe("messages to the server", () => {
  test("are byte for byte what models without a server sent", () => {
    for (const [uri, sent] of [
      [file("/repo/a b/ü.py"), "file:///repo/a%20b/%C3%BC.py"],
      [loxel("/repo/src/a.ts"), "loxel://head/repo/src/a.ts"],
      // JSON and YAML models are file-scheme: schema globs match the server's `file:///` URI.
      [file("/repo/.github/workflows/ci.yml"), "file:///repo/.github/workflows/ci.yml"],
      [file("/repo/tsconfig.json"), "file:///repo/tsconfig.json"],
    ]) {
      const didOpen = {
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: { textDocument: { uri, languageId: "x", version: 1, text: "body" } },
      };
      const expected = { ...didOpen, params: { textDocument: { ...didOpen.params.textDocument } } };
      expected.params.textDocument.uri = sent;
      expect(JSON.stringify(toServer(didOpen))).toBe(JSON.stringify(expected));
    }
  });

  test("carry a file rename's URIs as the server knows them", () => {
    const willRename = {
      jsonrpc: "2.0",
      id: 4,
      method: "workspace/willRenameFiles",
      params: { files: [{ oldUri: loxel("/repo/a.ts"), newUri: loxel("/repo/b.ts") }] },
    };
    expect(toServer(willRename).params.files).toEqual([
      { oldUri: "loxel://head/repo/a.ts", newUri: "loxel://head/repo/b.ts" },
    ]);
  });

  test("leave text, other servers' files and other schemes alone", () => {
    const didChange = {
      jsonrpc: "2.0",
      method: "textDocument/didChange",
      params: {
        textDocument: { uri: file("/repo/a.py"), version: 2 },
        contentChanges: [{ text: `open("${file("/repo/a.py")}")` }],
      },
    };
    expect(toServer(didChange).params.contentChanges).toBe(didChange.params.contentChanges);

    const request = {
      jsonrpc: "2.0",
      id: 1,
      method: "x",
      params: { items: [{ uri: "file://other-server/repo/a.py" }, { uri: "jdt://contents/A" }] },
    };
    expect(toServer(request)).toBe(request);
  });
});

describe("messages from the server", () => {
  test("put diagnostics, with their related information, on the editor models", () => {
    const published = {
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri: "file:///repo/a.py",
        diagnostics: [
          {
            range,
            message: "see file:///repo/b.py",
            relatedInformation: [{ location: { uri: "file:///repo/b.py", range }, message: "b" }],
          },
        ],
      },
    };
    const translated = toClient(published);
    expect(translated.params.uri).toBe(file("/repo/a.py"));
    expect(translated.params.diagnostics[0]!.message).toBe("see file:///repo/b.py");
    expect(translated.params.diagnostics[0]!.relatedInformation[0]!.location.uri).toBe(
      file("/repo/b.py"),
    );
  });

  test("put pull diagnostics' related documents on their models", () => {
    const report = {
      jsonrpc: "2.0",
      id: 3,
      result: {
        kind: "full",
        items: [],
        relatedDocuments: { "file:///repo/b.py": { kind: "full", items: [] } },
      },
    };
    expect(Object.keys(toClient(report).result.relatedDocuments)).toEqual([file("/repo/b.py")]);
  });

  test("point definitions and references at editor models, also of files no tab has open", () => {
    const definition = {
      jsonrpc: "2.0",
      id: 7,
      result: [
        { targetUri: "loxel://HEAD/repo/b.ts", targetRange: range, targetSelectionRange: range },
        { uri: "file:///usr/lib/python3.12/os.py", range },
      ],
    };
    expect(toClient(definition).result).toEqual([
      { targetUri: loxel("/repo/b.ts"), targetRange: range, targetSelectionRange: range },
      { uri: file("/usr/lib/python3.12/os.py"), range },
    ]);

    const references = {
      jsonrpc: "2.0",
      id: 8,
      result: [
        { uri: "file:///repo/a.py", range },
        { uri: "file:///repo/sub/c.py", range },
      ],
    };
    expect(toClient(references).result.map((r) => r.uri)).toEqual([
      file("/repo/a.py"),
      file("/repo/sub/c.py"),
    ]);
  });

  test("put a rename's edits across files on their models, and keep the edits' text", () => {
    const rename = {
      jsonrpc: "2.0",
      id: 9,
      result: {
        changes: {
          "loxel://head/repo/a.ts": [{ range, newText: 'import "file:///x"' }],
          "file:///repo/data.json": [{ range, newText: "b" }],
        },
      },
    };
    // Keyed by URI, so its keys are the translated ones.
    const changes: Record<string, unknown> = toClient(rename).result.changes;
    expect(Object.keys(changes)).toEqual([loxel("/repo/a.ts"), file("/repo/data.json")]);
    expect(changes[loxel("/repo/a.ts")]).toEqual([{ range, newText: 'import "file:///x"' }]);
  });

  test("put a workspace edit's document changes and file operations on editor models", () => {
    const applyEdit = {
      jsonrpc: "2.0",
      id: 2,
      method: "workspace/applyEdit",
      params: {
        edit: {
          documentChanges: [
            { textDocument: { uri: "file:///repo/a.py", version: 3 }, edits: [] },
            { kind: "create", uri: "file:///repo/new.py" },
            { kind: "rename", oldUri: "file:///repo/old.py", newUri: "file:///repo/moved.py" },
            { kind: "delete", uri: "file:///repo/gone.py" },
          ],
        },
      },
    };
    expect(toClient(applyEdit).params.edit.documentChanges).toEqual([
      { textDocument: { uri: file("/repo/a.py"), version: 3 }, edits: [] },
      { kind: "create", uri: file("/repo/new.py") },
      { kind: "rename", oldUri: file("/repo/old.py"), newUri: file("/repo/moved.py") },
      { kind: "delete", uri: file("/repo/gone.py") },
    ]);
  });

  test("leave hover text, links and a server's own documents as they are", () => {
    const hover = {
      jsonrpc: "2.0",
      id: 5,
      result: { contents: { kind: "markdown", value: "[os](file:///usr/lib/os.py#L3)" } },
    };
    expect(toClient(hover)).toBe(hover);
    const library = { jsonrpc: "2.0", id: 6, result: [{ uri: "jdt://contents/List", range }] };
    expect(toClient(library)).toBe(library);
  });

  test("return opaque data to the server as it sent it", () => {
    const completion = {
      jsonrpc: "2.0",
      id: 10,
      result: { items: [{ label: "x", data: { uri: "file:///repo/a.py", nested: ["file:///"] } }] },
    };
    const item = toClient(completion).result.items[0]!;
    expect(item.data.uri).toBe(file("/repo/a.py"));
    const resolve = { jsonrpc: "2.0", id: 11, method: "completionItem/resolve", params: item };
    expect(toServer(resolve).params).toEqual(completion.result.items[0]!);
  });
});

describe("translateLspUris", () => {
  test("translates what the client sends and what the server answers", async () => {
    const sent: unknown[] = [];
    let deliver: ((message: unknown) => void) | undefined;
    const socket = {
      state: { value: { state: "open" } },
      send: async (message: unknown) => {
        sent.push(message);
      },
      setListener: (listener: ((message: unknown) => void) | undefined) => {
        deliver = listener;
      },
      toString: () => "socket",
    } as unknown as LspTransport;
    const received: unknown[] = [];
    const transport = translateLspUris(socket, SERVER);
    transport.setListener((message) => received.push(message));

    await transport.send({
      jsonrpc: "2.0",
      method: "textDocument/didClose",
      params: { textDocument: { uri: loxel("/repo/a.ts") } },
    });
    deliver?.({ jsonrpc: "2.0", id: 1, result: { uri: "loxel://HEAD/repo/a.ts", range } });

    expect(sent).toEqual([
      {
        jsonrpc: "2.0",
        method: "textDocument/didClose",
        params: { textDocument: { uri: "loxel://head/repo/a.ts" } },
      },
    ]);
    expect(received).toEqual([
      { jsonrpc: "2.0", id: 1, result: { uri: loxel("/repo/a.ts"), range } },
    ]);
    expect(transport.state).toBe(socket.state);
  });
});
