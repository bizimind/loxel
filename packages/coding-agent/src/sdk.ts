/**
 * In-process SDK for hosting a coding-agent runtime.
 *
 * Provides a typed `send()` / `on()` interface that replaces the
 * stdin/stdout JSON protocol used when coding-agent runs as a subprocess.
 */
import { createNoopLogger, type AppLogger } from "@bizimind/logger";

import type { ModelRouterOptions } from "./orchestrator/model-router.ts";
import type { RuntimeDiagnostic, RuntimeEventSink } from "./orchestrator/runtime.ts";
import { CodingAgentRuntime } from "./orchestrator/runtime.ts";
import type { ProtocolEvent, ProtocolRequest } from "./protocol/schemas.ts";

export interface CodingAgentSessionOptions {
  /** Model configuration with per-function API key support. */
  models?: ModelRouterOptions;
  /** Logger conforming to AppLogger interface. */
  logger?: AppLogger;
  /** Environment variables for subprocess spawns (grep, bash). When undefined, inherits process.env. */
  env?: Record<string, string | undefined>;
}

export type SessionEventListener = (event: ProtocolEvent) => void;
export type SessionErrorListener = (diagnostic: RuntimeDiagnostic) => void;

/**
 * Low-level protocol-oriented session wrapper.
 * Use the `Session` class instead for direct programmatic use.
 * This class is still appropriate for protocol bridges (e.g., AgentManager)
 * that forward raw ProtocolRequest/ProtocolEvent between transport layers.
 */
export class CodingAgentSession {
  private readonly runtime: CodingAgentRuntime;
  private readonly eventListeners = new Set<SessionEventListener>();
  private readonly errorListeners = new Set<SessionErrorListener>();
  private readonly unsubDiagnostic: () => void;
  private destroyed = false;

  constructor(options: CodingAgentSessionOptions = {}) {
    const logger = options.logger ?? createNoopLogger();

    const sink: RuntimeEventSink = {
      emit: async (event) => {
        for (const listener of this.eventListeners) {
          listener(event);
        }
      },
    };

    this.runtime = new CodingAgentRuntime(sink, logger, options.models, options.env);

    this.unsubDiagnostic = this.runtime.on("error", (diagnostic) => {
      for (const listener of this.errorListeners) {
        listener(diagnostic);
      }
    });
  }

  /** Send a typed protocol request to the runtime. */
  async send(request: ProtocolRequest): Promise<void> {
    if (this.destroyed) throw new Error("CodingAgentSession is destroyed");
    await this.runtime.handleRequest(request);
  }

  /** Subscribe to protocol events emitted by the runtime. */
  on(event: "event", listener: SessionEventListener): () => void;
  /** Subscribe to runtime diagnostics (warnings and errors). */
  on(event: "error", listener: SessionErrorListener): () => void;
  on(event: "event" | "error", listener: SessionEventListener | SessionErrorListener): () => void {
    if (event === "event") {
      const typed = listener as SessionEventListener;
      this.eventListeners.add(typed);
      return () => {
        this.eventListeners.delete(typed);
      };
    }
    const typed = listener as SessionErrorListener;
    this.errorListeners.add(typed);
    return () => {
      this.errorListeners.delete(typed);
    };
  }

  /** Tear down the session: reject pending operations and clear all listeners. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.unsubDiagnostic();
    this.runtime.destroy();
    this.eventListeners.clear();
    this.errorListeners.clear();
  }
}
