import { createTransportToWorker, createTransportToIFrame } from "@hediet/json-rpc-browser";
import { WebSocketTransport } from "@hediet/json-rpc-websocket";

import type { MonacoLspClientOptions } from "./adapters/LspClient";
import { MonacoLspClient } from "./adapters/LspClient";

export { MonacoLspClient, WebSocketTransport, createTransportToWorker, createTransportToIFrame };
export { capabilities } from "./types";
export type { MonacoLspClientOptions };
export type { RegistrableCapability, OptionsOf } from "./adapters/LspCapabilitiesRegistry";
export type { ClientCapabilities } from "./types";
