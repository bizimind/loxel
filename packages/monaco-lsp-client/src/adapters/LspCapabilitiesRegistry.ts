import { TypedChannel } from "@hediet/json-rpc";

import type {
  ClientCapabilities,
  ServerCapabilities,
  TextDocumentChangeRegistrationOptions,
} from "../types";
import type { IDisposable } from "../utils";

import { Capability, api, capabilities, TextDocumentSyncKind } from "../types";
import { Disposable } from "../utils";

/**
 * Union of all known capabilities from the static `capabilities` const.
 * Restricts registrations to the known LSP capability set — there are no
 * user-defined capabilities (the registry doesn't expose a way to create them).
 */
export type RegistrableCapability = (typeof capabilities)[keyof typeof capabilities];

/**
 * Extracts the options type from a `Capability<T>`. Distributive over unions,
 * so `OptionsOf<Capability<A> | Capability<B>>` yields `A | B`, and narrowing
 * C to a single member narrows this to that member's T.
 */
export type OptionsOf<C> = C extends Capability<infer T> ? T : never;

export interface ILspCapabilitiesRegistry {
  addStaticClientCapabilities(capability: ClientCapabilities): IDisposable;
  registerCapabilityHandler<C extends RegistrableCapability>(
    capability: C,
    handleStaticCapability: boolean,
    handler: (capability: OptionsOf<C>) => IDisposable,
  ): IDisposable;
}

export class LspCapabilitiesRegistry extends Disposable implements ILspCapabilitiesRegistry {
  private readonly _staticCapabilities = new Set<{ cap: ClientCapabilities }>();
  private readonly _dynamicFromStatic = DynamicFromStaticOptions.create();
  private readonly _registrations = new Map<Capability<unknown>, CapabilityInfo>();
  private _serverCapabilities: ServerCapabilities | undefined = undefined;

  constructor(private readonly _connection: TypedChannel) {
    super();

    this._register(
      this._connection.registerRequestHandler(
        api.client.clientRegisterCapability,
        async (params) => {
          for (const registration of params.registrations) {
            const capability = getCapabilityByMethod(registration.method);
            const r = new CapabilityRegistration(
              registration.id,
              capability,
              registration.registerOptions,
              false,
            );
            this._registerCapabilityOptions(r);
          }
          return { ok: null };
        },
      ),
    );

    this._register(
      this._connection.registerRequestHandler(
        api.client.clientUnregisterCapability,
        async (params) => {
          for (const unregistration of params.unregisterations) {
            const capability = getCapabilityByMethod(unregistration.method);
            const info = this._registrations.get(capability);
            const handlerInfo = info?.registrations.get(unregistration.id);
            if (!handlerInfo) {
              throw new Error(
                `No registration for method ${unregistration.method} with id ${unregistration.id}`,
              );
            }
            handlerInfo?.handlerDisposables.forEach((d) => d.dispose());
            info?.registrations.delete(unregistration.id);
          }
          return { ok: null };
        },
      ),
    );
  }

  private _registerCapabilityOptions(registration: CapabilityRegistration): void {
    let registrationForMethod = this._registrations.get(registration.capability);
    if (!registrationForMethod) {
      registrationForMethod = new CapabilityInfo();
      this._registrations.set(registration.capability, registrationForMethod);
    }
    if (registrationForMethod.registrations.has(registration.id)) {
      throw new Error(
        `Handler for method ${registration.capability.method} with id ${registration.id} already registered`,
      );
    }
    registrationForMethod.registrations.set(registration.id, registration);
    for (const h of registrationForMethod.handlers) {
      if (!h.handleStaticCapability && registration.isFromStatic) {
        continue;
      }
      registration.handlerDisposables.set(h, h.handler(registration.options));
    }
  }

  setServerCapabilities(serverCapabilities: ServerCapabilities) {
    if (this._serverCapabilities) {
      throw new Error("Server capabilities already set");
    }
    this._serverCapabilities = serverCapabilities;
    for (const cap of Object.values(capabilities)) {
      const capKey = cap as Capability<unknown>;
      const options = this._dynamicFromStatic.getOptions(capKey, serverCapabilities);
      // LSP servers return `false` for capability fields (e.g. `hoverProvider: false`)
      // to explicitly signal "not supported" — skip those as well as `undefined`.
      if (options !== undefined && options !== false) {
        this._registerCapabilityOptions(
          new CapabilityRegistration(cap.method, capKey, options, true),
        );
      }
    }
  }

  getClientCapabilities(): ClientCapabilities {
    const result: Record<string, unknown> = {};
    for (const c of this._staticCapabilities) {
      deepAssign(result, c.cap as unknown as Record<string, unknown>);
    }
    return result as ClientCapabilities;
  }

  addStaticClientCapabilities(capability: ClientCapabilities): IDisposable {
    const obj = { cap: capability };
    this._staticCapabilities.add(obj);
    return {
      dispose: () => {
        this._staticCapabilities.delete(obj);
      },
    };
  }

  registerCapabilityHandler<C extends RegistrableCapability>(
    capability: C,
    handleStaticCapability: boolean,
    handler: (capability: OptionsOf<C>) => IDisposable,
  ): IDisposable {
    const capKey = capability as Capability<unknown>;
    let info = this._registrations.get(capKey);
    if (!info) {
      info = new CapabilityInfo();
      this._registrations.set(capKey, info);
    }
    const handlerInfo = new CapabilityHandler(
      capKey,
      handleStaticCapability,
      handler as (capabilityOptions: unknown) => IDisposable,
    );
    info.handlers.add(handlerInfo);

    for (const registration of info.registrations.values()) {
      if (!handlerInfo.handleStaticCapability && registration.isFromStatic) {
        continue;
      }
      registration.handlerDisposables.set(handlerInfo, handlerInfo.handler(registration.options));
    }

    return {
      dispose: () => {
        info.handlers.delete(handlerInfo);
        for (const registration of info.registrations.values()) {
          const disposable = registration.handlerDisposables.get(handlerInfo);
          if (disposable) {
            disposable.dispose();
            registration.handlerDisposables.delete(handlerInfo);
          }
        }
      },
    };
  }
}

// Internal type-erased storage: all handlers for a given capability share the same T
// at runtime, but TypeScript can't express that existentially — so we erase to `unknown`
// here and cast at the public-API boundary in registerCapabilityHandler.
class CapabilityHandler {
  constructor(
    public readonly capability: Capability<unknown>,
    public readonly handleStaticCapability: boolean,
    public readonly handler: (capabilityOptions: unknown) => IDisposable,
  ) {}
}

class CapabilityRegistration {
  public readonly handlerDisposables = new Map<CapabilityHandler, IDisposable>();

  constructor(
    public readonly id: string,
    public readonly capability: Capability<unknown>,
    public readonly options: unknown,
    public readonly isFromStatic: boolean,
  ) {}
}

const capabilitiesByMethod = new Map(Object.values(capabilities).map((c) => [c.method, c]));
function getCapabilityByMethod(method: string): Capability<unknown> {
  const c = capabilitiesByMethod.get(method);
  if (!c) {
    throw new Error(`No capability found for method ${method}`);
  }
  return c;
}

class CapabilityInfo {
  public readonly handlers = new Set<CapabilityHandler>();
  public readonly registrations = new Map</* id */ string, CapabilityRegistration>();
}

class DynamicFromStaticOptions {
  private readonly _mappings = new Map<
    /* method */ string,
    (serverCapabilities: ServerCapabilities) => unknown
  >();

  public static create(): DynamicFromStaticOptions {
    const o = new DynamicFromStaticOptions();
    o.set(capabilities.textDocumentDidChange, (s) => {
      if (s.textDocumentSync === undefined) {
        return undefined;
      }
      if (typeof s.textDocumentSync === "object") {
        return {
          syncKind: s.textDocumentSync.change ?? TextDocumentSyncKind.None,
          documentSelector: null,
        } satisfies TextDocumentChangeRegistrationOptions;
      }
      return {
        syncKind: s.textDocumentSync,
        documentSelector: null,
      } satisfies TextDocumentChangeRegistrationOptions;
    });

    o.set(capabilities.textDocumentCompletion, (s) => s.completionProvider);
    o.set(capabilities.textDocumentHover, (s) => s.hoverProvider);
    o.set(capabilities.textDocumentSignatureHelp, (s) => s.signatureHelpProvider);
    o.set(capabilities.textDocumentDefinition, (s) => s.definitionProvider);
    o.set(capabilities.textDocumentReferences, (s) => s.referencesProvider);
    o.set(capabilities.textDocumentDocumentHighlight, (s) => s.documentHighlightProvider);
    o.set(capabilities.textDocumentDocumentSymbol, (s) => s.documentSymbolProvider);
    o.set(capabilities.textDocumentCodeAction, (s) => s.codeActionProvider);
    o.set(capabilities.textDocumentCodeLens, (s) => s.codeLensProvider);
    o.set(capabilities.textDocumentDocumentLink, (s) => s.documentLinkProvider);
    o.set(capabilities.textDocumentFormatting, (s) => s.documentFormattingProvider);
    o.set(capabilities.textDocumentRangeFormatting, (s) => s.documentRangeFormattingProvider);
    o.set(capabilities.textDocumentOnTypeFormatting, (s) => s.documentOnTypeFormattingProvider);
    o.set(capabilities.textDocumentRename, (s) => s.renameProvider);
    o.set(capabilities.textDocumentFoldingRange, (s) => s.foldingRangeProvider);
    o.set(capabilities.textDocumentDeclaration, (s) => s.declarationProvider);
    o.set(capabilities.textDocumentTypeDefinition, (s) => s.typeDefinitionProvider);
    o.set(capabilities.textDocumentImplementation, (s) => s.implementationProvider);
    o.set(capabilities.textDocumentDocumentColor, (s) => s.colorProvider);
    o.set(capabilities.textDocumentSelectionRange, (s) => s.selectionRangeProvider);
    o.set(capabilities.textDocumentLinkedEditingRange, (s) => s.linkedEditingRangeProvider);
    o.set(capabilities.textDocumentPrepareCallHierarchy, (s) => s.callHierarchyProvider);
    o.set(capabilities.textDocumentSemanticTokensFull, (s) => s.semanticTokensProvider);
    o.set(capabilities.textDocumentInlayHint, (s) => s.inlayHintProvider);
    o.set(capabilities.textDocumentInlineValue, (s) => s.inlineValueProvider);
    o.set(capabilities.textDocumentInlineCompletion, (s) => s.inlineCompletionProvider);
    o.set(capabilities.textDocumentDiagnostic, (s) => s.diagnosticProvider);
    o.set(capabilities.textDocumentMoniker, (s) => s.monikerProvider);
    o.set(capabilities.textDocumentPrepareTypeHierarchy, (s) => s.typeHierarchyProvider);
    o.set(capabilities.workspaceSymbol, (s) => s.workspaceSymbolProvider);
    o.set(capabilities.workspaceExecuteCommand, (s) => s.executeCommandProvider);
    return o;
  }

  set<T>(
    capability: Capability<T>,
    getOptionsFromStatic: (serverCapabilities: ServerCapabilities) => T | boolean | undefined,
  ): void {
    if (this._mappings.has(capability.method)) {
      throw new Error(`Capability for method ${capability.method} already registered`);
    }
    this._mappings.set(
      capability.method,
      getOptionsFromStatic as (s: ServerCapabilities) => unknown,
    );
  }

  getOptions(capability: Capability<unknown>, serverCapabilities: ServerCapabilities): unknown {
    const getter = this._mappings.get(capability.method);
    if (!getter) {
      return undefined;
    }
    return getter(serverCapabilities);
  }
}

function deepAssign(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(source)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }
    const srcValue = source[key];
    if (srcValue === undefined) {
      continue;
    }
    const tgtValue = target[key];
    if (tgtValue === undefined) {
      target[key] = srcValue;
      continue;
    }

    if (typeof srcValue !== "object" || srcValue === null) {
      target[key] = srcValue;
      continue;
    }
    if (typeof tgtValue !== "object" || tgtValue === null) {
      target[key] = srcValue;
      continue;
    }

    deepAssign(tgtValue as Record<string, unknown>, srcValue as Record<string, unknown>);
  }
}
