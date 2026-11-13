import type { AgentClientMessage, AgentEvent } from "@/api/agent-session-model";
import { isUuid } from "@/lib/uuid";

import { logger } from "../logger";
import { AgentSession, type AgentClient, type AgentTransportFactory } from "./agent-session";

const log = logger.child("agent");

export interface AgentManagerDeps {
  createTransport: AgentTransportFactory;
  /**
   * The conversation so far of a session being resumed, for a panel that lost it, or null when
   * the agent has no such session (it never got a message, so there is nothing to resume).
   */
  loadHistory(sessionId: string): Promise<readonly AgentEvent[] | null>;
  /** What a session in this worktree starts with (model, effort, mode), before its process answers. */
  startingEvents(worktreePath: string): Promise<readonly AgentEvent[]>;
}

/**
 * Agent sessions by panel id. A session is created by its panel's first attach and lives until
 * the panel sends `destroy` or the server stops; reattaching (a reload, a worktree switch, another
 * window) only adds a client. A session is registered before anything is awaited, so a `destroy`
 * that arrives while it is still being created stops it.
 */
export class AgentManager {
  private readonly sessions = new Map<string, Promise<AgentSession>>();

  constructor(private readonly deps: AgentManagerDeps) {}

  async handle(agentId: string, client: AgentClient, message: AgentClientMessage): Promise<void> {
    try {
      if (message.type === "attach") {
        await this.attach(agentId, client, message);
        return;
      }
      const session = await this.sessions.get(agentId);
      if (!session) {
        client.send({ type: "error", message: "This agent session is not attached" });
        return;
      }
      if (message.type === "destroy") this.sessions.delete(agentId);
      await session.handle(message);
    } catch (err) {
      log.warn("Agent request failed", { error: err, type: message.type });
      client.send({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  detach(agentId: string, client: AgentClient): void {
    void this.sessions.get(agentId)?.then(
      (session) => session.detach(client),
      () => {},
    );
  }

  async destroyAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(
      sessions.map((s) =>
        s.then(
          (session) => session.destroy(),
          () => {},
        ),
      ),
    );
  }

  private async attach(
    agentId: string,
    client: AgentClient,
    message: Extract<AgentClientMessage, { type: "attach" }>,
  ): Promise<void> {
    const since = { seq: message.sinceSeq, instanceId: message.instanceId };
    const existing = this.sessions.get(agentId);
    if (existing) {
      (await existing).attach(client, since);
      return;
    }
    const resumeId = message.resumeSessionId;
    if (resumeId !== undefined && !isUuid(resumeId)) {
      throw new Error("Invalid session id");
    }
    const creation = this.create(message.worktreePath, resumeId);
    const entry = creation.then(({ session }) => session);
    // Its failure is reported below; others awaiting the entry see it too.
    entry.catch(() => {});
    this.sessions.set(agentId, entry);
    let created: { session: AgentSession; resume: boolean };
    try {
      created = await creation;
    } catch (err) {
      this.sessions.delete(agentId);
      throw err;
    }
    log.info("Agent session created", { agentId, resumed: created.resume });
    created.session.attach(client);
    // A destroy that came meanwhile has already destroyed it, which makes this start a no-op.
    await created.session.start(created.resume);
  }

  private async create(
    worktreePath: string,
    resumeId: string | undefined,
  ): Promise<{ session: AgentSession; resume: boolean }> {
    const [history, starting] = await Promise.all([
      resumeId ? this.deps.loadHistory(resumeId) : null,
      this.deps.startingEvents(worktreePath).catch(() => []),
    ]);
    // A session that never got a message has no transcript; it starts afresh under its own id.
    const resume = history !== null;
    const session = new AgentSession(
      { worktreePath, sessionId: resumeId ?? crypto.randomUUID(), resume },
      this.deps.createTransport,
      [...starting, ...(history ?? [])],
    );
    return { session, resume };
  }
}
