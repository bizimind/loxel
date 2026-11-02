import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

import type { TypedChannel } from "@hediet/json-rpc";
import type * as monaco from "monaco-editor";

import { FakeEmitter, fakeMonaco, fakeMonacoModule } from "../testing/fake-monaco";
import type { Registration, ServerCapabilities, Unregistration } from "../types";
import type { api } from "../types";
import { capabilities, TextDocumentSyncKind } from "../types";

mock.module("monaco-editor", () => fakeMonacoModule);

const { LspCapabilitiesRegistry } = await import("./LspCapabilitiesRegistry");
const { TextDocumentSynchronizer } = await import("./TextDocumentSynchronizer");

/** Calls the handlers the registry registers on its channel, as requests from the server would. */
function createChannel() {
  const handlers = new Map<string, (params: unknown) => Promise<unknown>>();
  const channel = {
    registerRequestHandler: (
      type: { method: string },
      handler: (params: unknown) => Promise<unknown>,
    ) => {
      handlers.set(type.method, handler);
      return { dispose: () => handlers.delete(type.method) };
    },
  } as unknown as TypedChannel;
  const request = (method: string, params: unknown) => {
    const handler = handlers.get(method);
    if (!handler) throw new Error(`no handler for ${method}`);
    return handler(params);
  };
  return {
    channel,
    register: (registrations: Registration[]) =>
      request("client/registerCapability", { registrations }),
    unregister: (unregisterations: Unregistration[]) =>
      request("client/unregisterCapability", { unregisterations }),
  };
}

function createModel(path: string): monaco.editor.ITextModel {
  return {
    uri: fakeMonacoModule.Uri.file(path),
    getLanguageId: () => "cpp",
    getVersionId: () => 1,
    getValue: () => "int main() {}\n",
    onDidChangeContent: new FakeEmitter().event,
    onWillDispose: new FakeEmitter().event,
  } as unknown as monaco.editor.ITextModel;
}

const SEMANTIC_TOKENS_OPTIONS = {
  documentSelector: null,
  legend: { tokenTypes: [], tokenModifiers: [] },
  full: true,
};

describe("LspCapabilitiesRegistry", () => {
  describe("dynamic registrations", () => {
    let warn: ReturnType<typeof spyOn>;

    beforeEach(() => {
      warn = spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      warn.mockRestore();
    });

    test("textDocument/semanticTokens registers the semantic tokens capability", async () => {
      const { channel, register, unregister } = createChannel();
      const registry = new LspCapabilitiesRegistry(channel);
      const events: string[] = [];
      registry.registerCapabilityHandler(capabilities.textDocumentSemanticTokensFull, false, () => {
        events.push("registered");
        return { dispose: () => events.push("unregistered") };
      });

      await register([
        {
          id: "tokens",
          method: "textDocument/semanticTokens",
          registerOptions: SEMANTIC_TOKENS_OPTIONS,
        },
      ]);
      expect(events).toEqual(["registered"]);

      await unregister([{ id: "tokens", method: "textDocument/semanticTokens" }]);
      expect(events).toEqual(["registered", "unregistered"]);
      expect(warn).not.toHaveBeenCalled();
    });

    test("an unknown method is skipped with a warning and costs the others nothing", async () => {
      const { channel, register, unregister } = createChannel();
      const registry = new LspCapabilitiesRegistry(channel);
      const hovers: string[] = [];
      registry.registerCapabilityHandler(capabilities.textDocumentHover, false, () => {
        hovers.push("registered");
        return { dispose: () => hovers.push("unregistered") };
      });

      await register([
        { id: "unknown", method: "custom/feature" },
        { id: "hover", method: "textDocument/hover", registerOptions: { documentSelector: null } },
      ]);
      expect(hovers).toEqual(["registered"]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("custom/feature");

      await unregister([
        { id: "unknown", method: "custom/feature" },
        { id: "hover", method: "textDocument/hover" },
      ]);
      expect(hovers).toEqual(["registered", "unregistered"]);
    });
  });

  // Monaco asks a newly registered code action provider for actions at once, in the registration.
  describe("the server hears about open documents before any provider exists", () => {
    function setup() {
      fakeMonaco.reset();
      fakeMonaco.models.push(createModel("/a.cpp"));
      const { channel, register } = createChannel();
      const registry = new LspCapabilitiesRegistry(channel);
      const events: string[] = [];
      const server = {
        textDocumentDidOpen: () => events.push("didOpen"),
        textDocumentDidClose: () => {},
      } as unknown as typeof api.TServerInterface;
      const synchronizer = new TextDocumentSynchronizer(server, registry);
      registry.registerCapabilityHandler(capabilities.textDocumentCodeAction, true, () => {
        events.push("provider");
        return { dispose: () => {} };
      });
      return { registry, register, events, synchronizer };
    }

    test("from the initialize response", () => {
      const { registry, events, synchronizer } = setup();
      const caps: ServerCapabilities = {
        textDocumentSync: TextDocumentSyncKind.Incremental,
        codeActionProvider: true,
      };
      registry.setServerCapabilities(caps);
      expect(events).toEqual(["didOpen", "provider"]);
      synchronizer.dispose();
    });

    test("from one client/registerCapability request, whatever its order", async () => {
      const { register, events, synchronizer } = setup();
      await register([
        {
          id: "actions",
          method: "textDocument/codeAction",
          registerOptions: { documentSelector: null },
        },
        {
          id: "sync",
          method: "textDocument/didChange",
          registerOptions: { documentSelector: null, syncKind: TextDocumentSyncKind.Full },
        },
      ]);
      expect(events).toEqual(["didOpen", "provider"]);
      synchronizer.dispose();
    });
  });
});

describe("registrations without options", () => {
  test("reach the handler with empty options, which LSP allows and jdtls sends", async () => {
    const { channel, register } = createChannel();
    const registry = new LspCapabilitiesRegistry(channel);
    const handler = mock((options: { documentSelector?: unknown }) => {
      expect(options.documentSelector).toBeUndefined();
      return { dispose: () => {} };
    });
    registry.registerCapabilityHandler(capabilities.textDocumentHover, true, handler);

    await register([{ id: "hover", method: "textDocument/hover" }]);

    expect(handler).toHaveBeenCalledTimes(1);
    registry.dispose();
  });
});
