/**
 * Agent sessions by panel (`agentId`) and the `/ws/agent` socket protocol. Each socket belongs to
 * one panel: its first message attaches it to that panel's session, creating the session (and
 * resuming the saved agent session, after a server restart) when the server has none.
 */
import { z } from "zod";

import {
  EFFORT_LEVELS,
  PERMISSION_DESTINATIONS,
  PERMISSION_MODES,
  type AgentClientMessage,
  type AgentServerMessage,
} from "@/api/agent-session-model";

import { logger } from "../logger";
import { AgentSession, type AgentClient, type AgentStartGate } from "./agent-session";
import type { AgentBackend } from "./agent-transport";

const log = logger.child("agent");

const imageSchema = z.object({
  mediaType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  data: z.string(),
});

const responseSchema = z.union([
  z.object({ kind: z.literal("question"), answers: z.record(z.string(), z.string()) }),
  z.object({ kind: z.literal("question"), dismissed: z.literal(true) }),
  z.object({
    kind: z.literal("permission"),
    decision: z.literal("allow"),
    always: z
      .array(z.object({ id: z.string(), destination: z.enum(PERMISSION_DESTINATIONS).optional() }))
      .optional(),
  }),
  z.object({
    kind: z.literal("permission"),
    decision: z.literal("deny"),
    message: z.string().optional(),
    stop: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("plan"),
    decision: z.literal("approve"),
    mode: z.enum(PERMISSION_MODES),
  }),
  z.object({ kind: z.literal("plan"), decision: z.literal("keep_planning"), feedback: z.string() }),
]);

const clientMessageSchema: z.ZodType<AgentClientMessage> = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("attach"),
    agentId: z.string().min(1),
    cwd: z.string().min(1),
    resumeSessionId: z.uuid().optional(),
    handedOff: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("send"),
    text: z.string(),
    images: z.array(imageSchema).optional(),
    delivery: z.enum(["queue", "steer"]),
  }),
  z.object({ type: z.literal("interrupt") }),
  z.object({ type: z.literal("respond"), interactionId: z.string(), response: responseSchema }),
  z.object({ type: z.literal("set_model"), model: z.string().min(1) }),
  z.object({ type: z.literal("set_effort"), effort: z.enum(EFFORT_LEVELS) }),
  z.object({ type: z.literal("set_permission_mode"), mode: z.enum(PERMISSION_MODES) }),
  z.object({ type: z.literal("hand_off") }),
  z.object({ type: z.literal("resume"), fresh: z.boolean().optional() }),
]);

/** What the server keeps on an agent socket. */
export interface AgentSocketData {
  type: "agent";
  session: AgentSession | null;
  client: AgentClient | null;
  /** Set when the socket closes, so a late attach does not bind a dead socket. */
  closed?: boolean;
}

export interface AgentSocket {
  data: AgentSocketData;
  send(data: string): unknown;
  close(code?: number, reason?: string): void;
}

export class AgentManager {
  private readonly sessions = new Map<string, AgentSession>();

  constructor(
    private readonly backend: AgentBackend,
    private readonly gate: AgentStartGate,
  ) {}

  async handleMessage(ws: AgentSocket, raw: string): Promise<void> {
    let message: AgentClientMessage;
    try {
      message = clientMessageSchema.parse(JSON.parse(raw));
    } catch (err) {
      log.warn("Malformed agent message", { error: err });
      return;
    }

    if (message.type === "attach") {
      await this.attach(ws, message);
      return;
    }
    await ws.data.session?.handle(message, ws.data.client ?? undefined);
  }

  /** The panel closed: end its session. */
  close(agentId: string): void {
    this.sessions.get(agentId)?.dispose();
    this.sessions.delete(agentId);
  }

  /** Bind the socket to the panel's session, creating (and starting) it if the server has none. */
  private async attach(
    ws: AgentSocket,
    { agentId, cwd, resumeSessionId, handedOff }: Extract<AgentClientMessage, { type: "attach" }>,
  ): Promise<void> {
    if (ws.data.session || ws.data.closed) return;
    const client: AgentClient = {
      send: (message: AgentServerMessage) => ws.send(JSON.stringify(message)),
    };
    let session = this.sessions.get(agentId);
    if (!session) {
      session = new AgentSession(this.backend, agentId, cwd, this.gate);
      this.sessions.set(agentId, session);
      void session.start(resumeSessionId, { handedOff: handedOff === true });
    }
    ws.data.session = session;
    ws.data.client = client;
    session.attach(client);
  }

  detach(ws: AgentSocket): void {
    ws.data.closed = true;
    if (ws.data.session && ws.data.client) ws.data.session.detach(ws.data.client);
    ws.data.session = null;
    ws.data.client = null;
  }

  /**
   * End the sessions no window is attached to, like orphaned terminals once their grace period is
   * over; a panel that comes back resumes its session by id. Returns how many ended.
   */
  disposeDetached(): number {
    let count = 0;
    for (const [agentId, session] of this.sessions) {
      if (session.hasClients) continue;
      session.dispose();
      this.sessions.delete(agentId);
      count += 1;
    }
    return count;
  }

  disposeAll(): void {
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
  }
}
