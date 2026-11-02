import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

import type { TypedChannel } from "@hediet/json-rpc";
import type * as monaco from "monaco-editor";

import { FakeEmitter, fakeMonaco, fakeMonacoModule } from "../testing/fake-monaco";
import type { Registration, ServerCapabilities, Unregistration } from "../types";
import type { api } from "../types";
import { capabilities, TextDocumentSyncKind } from "../types";
import type { LspConnection } from "./LspConnection";

mock.module("monaco-editor", () => fakeMonacoModule);

const { LspCapabilitiesRegistry } = await import("./LspCapabilitiesRegistry");
const { TextDocumentSynchronizer } = await import("./TextDocumentSynchronizer");
const { LspHoverFeature } = await import("./languageFeatures/LspHoverFeature");

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

function createModel(path: string, languageId = "cpp"): monaco.editor.ITextModel {
  return {
    uri: fakeMonacoModule.Uri.file(path),
    getLanguageId: () => languageId,
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

  // `registerOptions` is optional in the spec. jdtls registers most of its features without it.
  describe("a registration with no registerOptions", () => {
    let error: ReturnType<typeof spyOn>;

    beforeEach(() => {
      fakeMonaco.reset();
      error = spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
      error.mockRestore();
    });

    /** A real hover feature on a client for Java, whose server answers every hover. */
    function setupJavaHover() {
      const { channel, register, unregister } = createChannel();
      const registry = new LspCapabilitiesRegistry(channel);
      const server = {
        textDocumentDidOpen: () => {},
        textDocumentDidClose: () => {},
        textDocumentHover: async () => ({ contents: "docs" }),
      } as unknown as typeof api.TServerInterface;
      const bridge = new TextDocumentSynchronizer(server, registry, new Set(["java"]));
      const hover = new LspHoverFeature({
        capabilities: registry,
        bridge,
        server,
        defaultLanguageIds: ["java"],
      } as unknown as LspConnection);
      const provide = (model: monaco.editor.ITextModel) => {
        const provider = fakeMonaco.providers.get("Hover") as monaco.languages.HoverProvider;
        const position = new fakeMonacoModule.Position(1, 1) as monaco.Position;
        return provider.provideHover(model, position, {} as monaco.CancellationToken);
      };
      const dispose = () => {
        hover.dispose();
        bridge.dispose();
      };
      return { register, unregister, provide, dispose };
    }

    test("registers the feature on the client's languages only, and it answers", async () => {
      const { register, unregister, provide, dispose } = setupJavaHover();

      await register([
        { id: "sync", method: "textDocument/didChange", registerOptions: { syncKind: 2 } },
        { id: "hover", method: "textDocument/hover" },
      ]);

      // The same selector a static `hoverProvider: true` gets, not `{ language: "*" }`.
      expect(fakeMonaco.providerSelectors.get("Hover")).toEqual({ language: "java" });
      expect(await provide(createModel("/A.java", "java"))).toMatchObject({
        contents: [{ value: "docs" }],
      });
      expect(await provide(createModel("/a.py", "python"))).toBeNull();

      await unregister([{ id: "hover", method: "textDocument/hover" }]);
      expect(fakeMonaco.providers.has("Hover")).toBe(false);
      dispose();
    });

    // Their handlers would otherwise fail later, on every use, instead of in the registration.
    test.each([
      "textDocument/didChange",
      "textDocument/semanticTokens",
      "textDocument/onTypeFormatting",
      "workspace/executeCommand",
      "workspace/willRenameFiles",
    ])("%s, whose options the spec requires, fails alone", async (method) => {
      const { channel, register } = createChannel();
      const registry = new LspCapabilitiesRegistry(channel);
      const called: string[] = [];
      for (const capability of Object.values(capabilities)) {
        registry.registerCapabilityHandler(capability, false, () => {
          called.push(capability.method);
          return { dispose: () => {} };
        });
      }

      const answer = await register([
        { id: "bad", method },
        { id: "hover", method: "textDocument/hover" },
      ]);

      expect(answer).toEqual({ errorMessage: expect.stringContaining(method) });
      expect(called).toEqual(["textDocument/hover"]);
    });
  });

  describe("a registration whose handler throws", () => {
    test("costs the others nothing, and the server hears which one failed", async () => {
      const error = spyOn(console, "error").mockImplementation(() => {});
      const { channel, register } = createChannel();
      const registry = new LspCapabilitiesRegistry(channel);
      const hovers: string[] = [];
      registry.registerCapabilityHandler(capabilities.textDocumentDefinition, false, () => {
        throw new Error("handler broke");
      });
      registry.registerCapabilityHandler(capabilities.textDocumentHover, false, () => {
        hovers.push("registered");
        return { dispose: () => {} };
      });

      const answer = await register([
        { id: "definition", method: "textDocument/definition" },
        { id: "hover", method: "textDocument/hover" },
      ]);

      // An answer rather than a throw: the channel keeps a thrown error's message from the server.
      expect(answer).toEqual({ errorMessage: "textDocument/definition: handler broke" });
      expect(hovers).toEqual(["registered"]);
      expect(error).toHaveBeenCalledTimes(1);
      error.mockRestore();
    });
  });

  test("a repeated id fails alone", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    const { channel, register } = createChannel();
    const registry = new LspCapabilitiesRegistry(channel);
    const registered: string[] = [];
    for (const capability of [
      capabilities.textDocumentHover,
      capabilities.textDocumentDefinition,
    ]) {
      registry.registerCapabilityHandler(capability, false, () => {
        registered.push(capability.method);
        return { dispose: () => {} };
      });
    }
    await register([{ id: "hover", method: "textDocument/hover" }]);

    const answer = await register([
      { id: "hover", method: "textDocument/hover" },
      { id: "definition", method: "textDocument/definition" },
    ]);

    expect(answer).toEqual({ errorMessage: expect.stringContaining("textDocument/hover") });
    expect(registered).toEqual(["textDocument/hover", "textDocument/definition"]);
    error.mockRestore();
  });

  test("unregistering an id with no registration warns and costs the others nothing", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const { channel, register, unregister } = createChannel();
    const registry = new LspCapabilitiesRegistry(channel);
    const hovers: string[] = [];
    registry.registerCapabilityHandler(capabilities.textDocumentHover, false, () => ({
      dispose: () => hovers.push("unregistered"),
    }));
    await register([{ id: "hover", method: "textDocument/hover" }]);

    await unregister([
      { id: "failed", method: "textDocument/hover" },
      { id: "hover", method: "textDocument/hover" },
    ]);

    expect(hovers).toEqual(["unregistered"]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
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
