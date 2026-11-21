import { beforeEach, describe, expect, mock, test } from "bun:test";

import type * as monaco from "monaco-editor";

import { fakeMonaco, fakeMonacoModule } from "../../testing/fake-monaco";
import type { DocumentLink } from "../../types";
import { capabilities } from "../../types";
import type { IDisposable } from "../../utils";
import type { LspConnection } from "../LspConnection";

mock.module("monaco-editor", () => fakeMonacoModule);

const { LspDocumentLinkFeature } = await import("./LspDocumentLinkFeature");

const URI = "file:///wt/Cargo.toml";
const model = { uri: fakeMonacoModule.Uri.parse(URI) } as unknown as monaco.editor.ITextModel;
const range = { start: { line: 0, character: 9 }, end: { line: 0, character: 40 } };

/** The links a server answering `links` shows in the editor. */
async function shownLinks(links: DocumentLink[]): Promise<Array<string | undefined>> {
  const handlers = new Map<unknown, (options: unknown) => IDisposable>();
  const noop = { dispose: () => {} };
  const connection = {
    server: { textDocumentDocumentLink: async () => links },
    capabilities: {
      addStaticClientCapabilities: () => noop,
      registerCapabilityHandler: (capability: unknown, _static: boolean, handler: never) => {
        handlers.set(capability, handler);
        return noop;
      },
    },
    bridge: {
      isSyncedModel: () => true,
      translate: () => ({ textDocument: { uri: URI }, position: { line: 0, character: 0 } }),
      translateBackRange: () => ({ range: { startLineNumber: 1 } }),
    },
    defaultLanguageIds: ["toml"],
  } as unknown as LspConnection;

  const feature = new LspDocumentLinkFeature(connection);
  handlers.get(capabilities.textDocumentDocumentLink)?.({ documentSelector: null });
  const provider = fakeMonaco.providers.get("Link") as monaco.languages.LinkProvider;
  const token = { isCancellationRequested: false } as monaco.CancellationToken;
  const list = await provider.provideLinks(model, token);
  feature.dispose();
  return (
    list?.links.map((link) => (typeof link.url === "string" ? link.url : link.url?.toString())) ??
    []
  );
}

describe("LspDocumentLinkFeature", () => {
  beforeEach(() => {
    fakeMonaco.reset();
  });

  test("shows links to files and web pages", async () => {
    expect(
      await shownLinks([
        { range, target: "https://json.schemastore.org/cargo.json" },
        { range, target: "file:///wt/schema.json" },
      ]),
    ).toEqual(["https://json.schemastore.org/cargo.json", "file:///wt/schema.json"]);
  });

  test("leaves out links whose target is a command: URI, in any case", async () => {
    expect(
      await shownLinks([
        { range, target: "command:editor.action.selectAll" },
        { range, target: " Command:editor.action.selectAll?%5B%5D" },
        { range, target: "https://example.com/schema.json" },
      ]),
    ).toEqual(["https://example.com/schema.json"]);
  });

  test("keeps a link without a target for the server to resolve later", async () => {
    expect(await shownLinks([{ range }])).toEqual([undefined]);
  });
});
