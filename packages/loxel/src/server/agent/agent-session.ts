/**
 * One agent panel's session on the server: owns the transcript, pending interactions, status and
 * settings the panel shows, drives the agent through an {@link AgentTransport}, and keeps every
 * attached window in sync (a snapshot on attach, then incremental messages).
 */
import {
  emptyAgentSnapshot,
  type AgentClientMessage,
  type AgentServerMessage,
  type AgentSessionInfo,
  type AgentSnapshot,
  type AgentStatus,
  type InteractionResponse,
  type TranscriptItem,
} from "@/api/agent-session-model";

import { logger } from "../logger";
import type { AgentBackend, AgentTransport, AgentTransportSink } from "./agent-transport";
import { ClaudeMessageTranslator, type AgentUpdate } from "./claude-message-translator";
import {
  mapToolRequest,
  type ClaudePermissionResult,
  type ClaudeToolRequest,
  type MappedToolRequest,
} from "./claude-permissions";

const log = logger.child("agent");

/** Claude Code session ids are UUIDs. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AgentClient {
  send(message: AgentServerMessage): void;
}

/**
 * Whether the agent may start in `cwd`: null if so, else why not, for the user. Claude Code's
 * print mode skips its own folder-trust prompt, so Loxel's repository trust stands in for it.
 */
export type AgentStartGate = (cwd: string) => Promise<string | null>;

interface PendingInteraction {
  mapped: MappedToolRequest;
  resolve: (result: ClaudePermissionResult) => void;
}

export class AgentSession implements AgentTransportSink {
  private snapshot: AgentSnapshot;
  private transport: AgentTransport | null = null;
  private readonly clients = new Set<AgentClient>();
  private readonly pending = new Map<string, PendingInteraction>();
  /** What the agent reported doing, before pending interactions and failures are considered. */
  private activity: "starting" | "working" | "idle" = "starting";
  private handedOff = false;
  /** Bumped on every (re)start, so a transport that was replaced cannot report into the session. */
  private generation = 0;

  /** Set by an interrupt until its turn ends, which then reads as interrupted, not failed. */
  private interrupting = false;

  constructor(
    private readonly backend: AgentBackend,
    readonly agentId: string,
    cwd: string,
    private readonly gate: AgentStartGate = async () => null,
  ) {
    this.snapshot = emptyAgentSnapshot(cwd);
  }

  get status(): AgentStatus {
    return this.snapshot.status;
  }

  get hasClients(): boolean {
    return this.clients.size > 0;
  }

  attach(client: AgentClient): void {
    this.clients.add(client);
    client.send({ type: "snapshot", snapshot: this.snapshot });
  }

  detach(client: AgentClient): void {
    this.clients.delete(client);
  }

  /**
   * Start the agent, continuing `resumeSessionId` (with its transcript) when given. With
   * `handedOff`, only show the transcript: the session continues in a terminal (a panel restored
   * after a server restart while it was handed off) until the user resumes it here.
   */
  async start(resumeSessionId?: string, { handedOff = false } = {}): Promise<void> {
    const generation = ++this.generation;
    this.denyPending("The session was restarted.");
    const previous = this.transport;
    this.transport = null;
    // Two processes must never write one session: the old one ends before the new one starts.
    await previous?.close();
    if (generation !== this.generation) return;

    this.handedOff = handedOff;
    this.interrupting = false;
    this.activity = "starting";
    const cwd = this.snapshot.info.cwd;
    this.snapshot = {
      ...emptyAgentSnapshot(cwd),
      info: { ...this.snapshot.info, error: null, sessionId: resumeSessionId ?? null },
    };
    const items = resumeSessionId ? await this.history(resumeSessionId) : [];
    if (generation !== this.generation) return;
    this.snapshot.items = items;
    this.refreshStatus();
    this.broadcast({ type: "snapshot", snapshot: this.snapshot });
    if (handedOff) return;

    const refusal = await this.gate(cwd);
    if (generation !== this.generation) return;
    if (refusal) {
      this.fail(refusal);
      return;
    }

    try {
      const transport = await this.backend.start({
        cwd: this.snapshot.info.cwd,
        resumeSessionId,
        sink: this.sinkFor(generation),
      });
      if (generation !== this.generation) {
        void transport.close();
        return;
      }
      this.transport = transport;
      this.activity = "idle";
      this.refreshStatus();
    } catch (err) {
      if (generation !== this.generation) return;
      this.fail(err instanceof Error ? err.message : String(err));
    }
  }

  private async history(sessionId: string): Promise<TranscriptItem[]> {
    const translator = new ClaudeMessageTranslator();
    const scratch: AgentSnapshot = emptyAgentSnapshot(this.snapshot.info.cwd);
    try {
      for (const message of await this.backend.loadHistory(sessionId, this.snapshot.info.cwd)) {
        for (const update of translator.translate(message, { fromHistory: true })) {
          applyTranscriptUpdate(scratch, update);
        }
      }
    } catch (err) {
      log.warn("Could not read the agent session's history", { error: err });
      return [noticeItem("The earlier conversation could not be loaded.", "error")];
    }
    return scratch.items;
  }

  /** A sink that ignores a transport replaced by a later start. */
  private sinkFor(generation: number): AgentTransportSink {
    const current = () => generation === this.generation;
    return {
      update: (update) => current() && this.update(update),
      requestTool: (request, signal) =>
        current()
          ? this.requestTool(request, signal)
          : Promise.resolve({ behavior: "deny", message: "The session was restarted." }),
      exit: (error) => current() && this.exit(error),
    };
  }

  update(update: AgentUpdate): void {
    switch (update.type) {
      case "info":
        this.setInfo(update.patch);
        return;
      case "activity":
        // A pending interaction already shows as "needs input"; the agent is otherwise working.
        this.activity = update.state === "idle" ? "idle" : "working";
        this.refreshStatus();
        return;
      case "turn_end":
        for (const item of this.snapshot.items) {
          if ((item.kind === "assistant" || item.kind === "thinking") && item.streaming) {
            this.putItem({ ...item, streaming: false });
          }
        }
        // An interrupted turn ends as an error whose text is only diagnostics.
        if (this.interrupting) this.putItem(noticeItem("Interrupted.", "info"));
        else if (update.error) this.putItem(noticeItem(update.error, "error"));
        this.interrupting = false;
        if (update.costUsd !== null) this.setInfo({ costUsd: update.costUsd });
        this.activity = "idle";
        this.refreshStatus();
        return;
      case "append":
        if (applyTranscriptUpdate(this.snapshot, update)) this.broadcast(update);
        return;
      case "item":
      case "tool_result":
      case "user_delivered": {
        const changed = applyTranscriptUpdate(this.snapshot, update);
        if (changed) this.broadcast({ type: "item", item: changed });
        return;
      }
      default: {
        const unknown: never = update;
        log.warn("Unknown agent update", { update: unknown });
      }
    }
  }

  requestTool(request: ClaudeToolRequest, signal: AbortSignal): Promise<ClaudePermissionResult> {
    const id = crypto.randomUUID();
    const mapped = mapToolRequest(id, request);
    return new Promise((resolve) => {
      const finish = (result: ClaudePermissionResult) => {
        if (!this.pending.delete(id)) return;
        signal.removeEventListener("abort", onAbort);
        this.snapshot.interactions = this.snapshot.interactions.filter((i) => i.id !== id);
        this.broadcast({ type: "interaction_resolved", id });
        this.refreshStatus();
        resolve(result);
      };
      const onAbort = () => finish({ behavior: "deny", message: "Interrupted." });
      if (signal.aborted) {
        resolve({ behavior: "deny", message: "Interrupted." });
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, { mapped, resolve: finish });
      this.snapshot.interactions = [...this.snapshot.interactions, mapped.interaction];
      this.broadcast({ type: "interaction", interaction: mapped.interaction });
      this.refreshStatus();
    });
  }

  exit(error: string | null): void {
    this.transport = null;
    this.denyPending("The agent stopped.");
    if (error) this.fail(error);
  }

  /** Handle a message from `client` (the window that sent it, which a hand-off answers). */
  async handle(message: AgentClientMessage, client?: AgentClient): Promise<void> {
    try {
      await this.dispatch(message, client);
    } catch (err) {
      log.warn("Agent request failed", { type: message.type, error: err });
      this.putItem(noticeItem(err instanceof Error ? err.message : String(err), "error"));
    }
  }

  private async dispatch(message: AgentClientMessage, client?: AgentClient): Promise<void> {
    switch (message.type) {
      case "attach":
        return;
      case "send": {
        if (message.text.trim() === "" && !message.images?.length) return;
        const transport = this.requireTransport();
        const uuid = crypto.randomUUID();
        this.putItem({
          kind: "user",
          id: uuid,
          text: message.text,
          imageCount: message.images?.length ?? 0,
          ...(this.activity === "working" ? { queued: true } : {}),
        });
        transport.send({
          uuid,
          text: message.text,
          images: message.images ?? [],
          delivery: message.delivery,
        });
        this.activity = "working";
        this.refreshStatus();
        return;
      }
      case "interrupt": {
        const transport = this.requireTransport();
        this.interrupting = this.activity === "working";
        await transport.interrupt();
        return;
      }
      case "respond":
        this.respond(message.interactionId, message.response);
        return;
      case "set_model":
        await this.requireTransport().setModel(message.model);
        this.setInfo({ model: message.model });
        return;
      case "set_effort":
        await this.requireTransport().setEffort(message.effort);
        this.setInfo({ effort: message.effort });
        return;
      case "set_permission_mode":
        await this.requireTransport().setPermissionMode(message.mode);
        this.setInfo({ permissionMode: message.mode });
        return;
      case "hand_off":
        await this.handOff(client);
        return;
      case "resume":
        await this.start(message.fresh ? undefined : (this.snapshot.info.sessionId ?? undefined));
        break;
      default: {
        const unknown: never = message;
        log.warn("Unknown agent message", { message: unknown });
      }
    }
  }

  private respond(interactionId: string, response: InteractionResponse): void {
    const pending = this.pending.get(interactionId);
    if (!pending) return;
    pending.resolve(pending.mapped.resolve(response));
  }

  private async handOff(requester: AgentClient | undefined): Promise<void> {
    const sessionId = this.snapshot.info.sessionId;
    if (!sessionId) {
      throw new Error("There is no conversation to continue yet: send a message first.");
    }
    // It is typed into a shell: only ever a session id.
    if (!SESSION_ID.test(sessionId)) throw new Error(`Not a session id: ${sessionId}`);
    ++this.generation;
    this.denyPending("The session moved to a terminal.");
    const transport = this.transport;
    this.transport = null;
    this.handedOff = true;
    this.refreshStatus();
    // The terminal's `claude --resume` must not start while this process still writes the session.
    await transport?.close();
    // Only the window that asked opens the terminal: one TUI per session.
    const message: AgentServerMessage = {
      type: "handed_off",
      command: `claude --resume ${sessionId}`,
      cwd: this.snapshot.info.cwd,
    };
    if (requester && this.clients.has(requester)) requester.send(message);
  }

  /** End the session for good: the panel closed. */
  dispose(): void {
    ++this.generation;
    this.denyPending("The panel was closed.");
    void this.transport?.close();
    this.transport = null;
    this.clients.clear();
  }

  private requireTransport(): AgentTransport {
    if (this.transport) return this.transport;
    throw new Error(
      this.handedOff
        ? "This session continues in a terminal. Resume it here first."
        : "The agent is not running.",
    );
  }

  private denyPending(message: string): void {
    for (const pending of [...this.pending.values()])
      pending.resolve({ behavior: "deny", message });
  }

  private fail(error: string): void {
    this.setInfo({ error });
    this.putItem(noticeItem(error, "error"));
    this.refreshStatus();
  }

  private setInfo(patch: Partial<AgentSessionInfo>): void {
    this.snapshot.info = { ...this.snapshot.info, ...patch };
    this.broadcast({ type: "info", info: this.snapshot.info });
  }

  private putItem(item: TranscriptItem): void {
    applyTranscriptUpdate(this.snapshot, { type: "item", item });
    this.broadcast({ type: "item", item });
  }

  private refreshStatus(): void {
    const status: AgentStatus = this.handedOff
      ? "handed_off"
      : this.snapshot.info.error && !this.transport
        ? "failed"
        : this.pending.size > 0
          ? "needs_input"
          : this.activity;
    if (status === this.snapshot.status) return;
    this.snapshot.status = status;
    this.broadcast({ type: "status", status });
  }

  private broadcast(message: AgentServerMessage): void {
    for (const client of this.clients) client.send(message);
  }
}

function noticeItem(text: string, tone: "info" | "error"): TranscriptItem {
  return { kind: "notice", id: crypto.randomUUID(), text, tone };
}

/**
 * Apply a transcript update to `snapshot` in place. Returns the item it changed, or null when the
 * update does not touch the transcript or refers to an item that is not there.
 */
export function applyTranscriptUpdate(
  snapshot: AgentSnapshot,
  update: AgentUpdate,
): TranscriptItem | null {
  const items = snapshot.items;
  const indexOf = (id: string) => items.findIndex((item) => item.id === id);
  switch (update.type) {
    case "item": {
      const index = indexOf(update.item.id);
      if (index === -1) items.push(update.item);
      else items[index] = update.item;
      return update.item;
    }
    case "append": {
      const index = indexOf(update.id);
      const item = items[index];
      if (!item || (item.kind !== "assistant" && item.kind !== "thinking")) return null;
      const next = { ...item, text: item.text + update.text };
      items[index] = next;
      return next;
    }
    case "tool_result": {
      const index = indexOf(update.toolUseId);
      const item = items[index];
      if (!item || item.kind !== "tool") return null;
      const next = { ...item, result: update.result };
      items[index] = next;
      return next;
    }
    case "user_delivered": {
      const index = indexOf(update.uuid);
      const item = items[index];
      if (!item || item.kind !== "user" || !item.queued) return null;
      const next = { ...item, queued: false };
      items[index] = next;
      return next;
    }
    case "info":
    case "activity":
    case "turn_end":
      return null;
    default: {
      const unknown: never = update;
      return unknown;
    }
  }
}
