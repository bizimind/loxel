import {
  type AgentClientMessage,
  type AgentEvent,
  type AgentServerMessage,
  type AgentState,
  applyAgentEvent,
  INITIAL_AGENT_STATE,
} from "@/api/agent-session-model";

import { logger } from "../logger";
import type { AgentLaunch, AgentTransport, AgentTransportHandlers } from "./agent-transport";

const log = logger.child("agent");

/** Where a session sends what its panel shows: each window showing the panel attaches one. */
export interface AgentClient {
  send(message: AgentServerMessage): void;
}

export type AgentTransportFactory = (
  launch: AgentLaunch,
  handlers: AgentTransportHandlers,
) => AgentTransport;

/** Events kept for clients that reconnect with the last sequence number they applied. */
const EVENT_LOG_LIMIT = 2000;

/**
 * One agent panel's session on the server: the process (through its transport), the state every
 * event has built, and the clients showing it. The process lives until the panel is closed, the
 * session is handed off to a terminal, or the server stops; clients may come and go meanwhile.
 * Starting and stopping the process are serialized, so a resume never overlaps a hand-off.
 */
export class AgentSession {
  private state: AgentState;
  private seq = 0;
  /** Names this session's numbering, so a client's `sinceSeq` from another server is not used. */
  private readonly instanceId = crypto.randomUUID();
  private readonly eventLog: { seq: number; event: AgentEvent }[] = [];
  private readonly clients = new Set<AgentClient>();
  private transport: AgentTransport | null = null;
  /** The transport is being stopped: it still reports, but takes no more commands. */
  private stopping = false;
  private destroyed = false;
  private lifecycle: Promise<void> = Promise.resolve();

  constructor(
    private readonly launch: AgentLaunch,
    private readonly createTransport: AgentTransportFactory,
    /** Events that rebuild the conversation of a resumed session, applied before it starts. */
    history: readonly AgentEvent[] = [],
  ) {
    this.state = { ...INITIAL_AGENT_STATE, sessionId: launch.sessionId };
    for (const event of history) this.state = applyAgentEvent(this.state, event);
  }

  get sessionId(): string {
    return this.launch.sessionId;
  }

  attach(client: AgentClient, since?: { seq?: number; instanceId?: string }): void {
    this.clients.add(client);
    const sinceSeq = since?.instanceId === this.instanceId ? since.seq : undefined;
    const first = this.eventLog[0];
    const covered = sinceSeq !== undefined && sinceSeq <= this.seq;
    if (covered && (first === undefined ? sinceSeq === this.seq : sinceSeq >= first.seq - 1)) {
      for (const entry of this.eventLog) {
        if (entry.seq > sinceSeq) client.send({ type: "event", ...entry });
      }
      return;
    }
    client.send({
      type: "snapshot",
      instanceId: this.instanceId,
      seq: this.seq,
      state: this.state,
    });
  }

  detach(client: AgentClient): void {
    this.clients.delete(client);
  }

  /** Starts the agent process on this session (a new one, or resumed after a hand-off). */
  start(resume: boolean): Promise<void> {
    return this.serialize(() => this.startNow(resume));
  }

  async handle(message: AgentClientMessage): Promise<void> {
    switch (message.type) {
      case "attach":
        return;
      case "resume":
        return this.serialize(async () => {
          if (this.transport || this.destroyed) return;
          this.emit([{ type: "handed_off", handedOff: false }]);
          // A session that never got a message has nothing on disk to resume yet.
          await this.startNow(this.state.items.some((item) => item.kind === "user"));
        });
      case "hand_off":
        return this.serialize(async () => {
          await this.stopNow();
          this.emit([
            { type: "handed_off", handedOff: true },
            { type: "status", status: "idle" },
          ]);
        });
      case "destroy":
        return this.destroy();
      case "send": {
        const transport = this.running();
        this.emit([
          {
            type: "user_message",
            id: message.id,
            text: message.text,
            imageCount: message.images?.length ?? 0,
            queued: true,
          },
        ]);
        transport.send({
          id: message.id,
          text: message.text,
          images: message.images ?? [],
          delivery: message.delivery,
        });
        return;
      }
      case "interrupt":
        return this.running().interrupt();
      case "respond": {
        const request = this.state.pending.find((r) => r.requestId === message.requestId);
        if (request) this.running().respond(request, message.response);
        return;
      }
      case "set_permission_mode":
        return this.running().setPermissionMode(message.mode);
      case "set_model":
        return this.running().setModel(message.model);
      case "set_effort":
        return this.running().setEffort(message.effort);
      case "refresh_context_usage":
        return this.running().refreshContextUsage();
      default: {
        const _unknown: never = message;
      }
    }
  }

  /** Stops the process for good; later starts do nothing. */
  destroy(): Promise<void> {
    this.destroyed = true;
    this.clients.clear();
    return this.serialize(() => this.stopNow());
  }

  /** The running transport; the manager reports the error to the client. */
  private running(): AgentTransport {
    if (!this.transport || this.stopping) {
      throw new Error("The agent is not running. Resume it first.");
    }
    return this.transport;
  }

  private serialize(step: () => Promise<void>): Promise<void> {
    const next = this.lifecycle.then(step);
    this.lifecycle = next.catch(() => {});
    return next;
  }

  private async startNow(resume: boolean): Promise<void> {
    if (this.transport || this.destroyed) return;
    const transport = this.createTransport(
      { ...this.launch, resume },
      {
        onEvents: (events) => {
          if (this.transport !== transport) return;
          this.emit(events);
          // Context usage after each turn, from the CLI's own count: no model call.
          if (events.some((event) => event.type === "turn_result") && !this.stopping) {
            transport.refreshContextUsage().catch(() => {});
          }
        },
        onExit: (error) => {
          if (this.transport !== transport) return;
          this.transport = null;
          this.emit([{ type: "exited", error }]);
        },
      },
    );
    this.transport = transport;
    this.emit([{ type: "status", status: "starting" }]);
    try {
      await transport.start();
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.error("Agent failed to start", { error: err, sessionId: this.sessionId });
      if (this.transport === transport) {
        this.transport = null;
        await transport.stop().catch(() => {});
        this.emit([{ type: "exited", error }]);
      }
    }
  }

  /** Stops the process, still applying what it reports until it is gone. */
  private async stopNow(): Promise<void> {
    const transport = this.transport;
    if (!transport) return;
    this.stopping = true;
    try {
      await transport.stop();
    } finally {
      this.stopping = false;
      if (this.transport === transport) this.transport = null;
    }
  }

  private emit(events: readonly AgentEvent[]): void {
    for (const event of events) {
      this.state = applyAgentEvent(this.state, event);
      this.seq += 1;
      this.eventLog.push({ seq: this.seq, event });
      for (const client of this.clients) client.send({ type: "event", seq: this.seq, event });
    }
    if (this.eventLog.length > EVENT_LOG_LIMIT) {
      this.eventLog.splice(0, this.eventLog.length - EVENT_LOG_LIMIT);
    }
  }
}
