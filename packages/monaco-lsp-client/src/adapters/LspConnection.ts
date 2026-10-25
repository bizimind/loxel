import { TypedChannel } from "@hediet/json-rpc";

import { api } from "../types";
import type { ITextModelBridge } from "./ITextModelBridge";
import type { LspCancellableRequests } from "./LspCancellableRequests";
import { LspCapabilitiesRegistry } from "./LspCapabilitiesRegistry";
import type { LspServerCommands } from "./LspServerCommands";

/**
 * Cross-feature coordination hook. Populated by `LspSemanticTokensFeature`
 * when it registers a provider; consumed by `LspFormattingFeature` to force
 * an immediate semantic-token re-request after format edits are applied,
 * bypassing Monaco's internal debounce that otherwise lets stale shifted
 * tokens paint for a visible frame.
 */
export interface SemanticTokensInvalidator {
  invalidate(uri: string): void;
}

export class LspConnection {
  public semanticTokensInvalidator: SemanticTokensInvalidator | null = null;

  constructor(
    public readonly server: typeof api.TServerInterface,
    public readonly bridge: ITextModelBridge,
    public readonly capabilities: LspCapabilitiesRegistry,
    public readonly connection: TypedChannel,
    public readonly commands: LspServerCommands,
    public readonly cancellableRequests: LspCancellableRequests,
    public readonly defaultLanguageIds?: readonly string[],
  ) {}
}
