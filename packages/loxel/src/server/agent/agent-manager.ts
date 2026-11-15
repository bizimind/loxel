import type {
  AgentClientMessage,
  AgentEvent,
  AgentSessionSummary,
} from "@/api/agent-session-model";
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
  loadHistory(sessionId: string, upTo?: string): Promise<readonly AgentEvent[] | null>;
  /** The worktree's sessions, newest first, for the picker. */
  listSessions(worktreePath: string): Promise<readonly AgentSessionSummary[]>;
  /** What a session in this worktree starts with (model, effort, mode), before its process answers. */
  startingEvents(worktreePath: string): Promise<readonly AgentEvent[]>;
  /** The prompts sent before in a worktree, oldest first. */
  promptHistory(worktreePath: string): Promise<readonly string[]>;
  /** Records a prompt the panel sent, so the TUI's history has it too. */
  recordPrompt(prompt: { display: string; project: string; sessionId: string }): Promise<void>;
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
      if (message.type === "rewind_preview") {
        const preview = await session.previewRewind(message.messageId);
        client.send({ type: "rewind_preview", messageId: message.messageId, preview });
        return;
      }
      if (message.type === "list_sessions") {
        client.send({
          type: "sessions",
          sessions: await this.deps.listSessions(session.worktreePath),
        });
        return;
      }
      if (message.type === "open_session") {
        await this.openSession(session, message);
        return;
      }
      if (message.type === "prompt_history") {
        client.send({
          type: "prompt_history",
          prompts: await this.deps.promptHistory(session.worktreePath),
        });
        return;
      }
      await session.handle(message);
      if (message.type === "send" && message.text.trim()) {
        this.deps
          .recordPrompt({
            display: message.text.trim(),
            project: session.worktreePath,
            sessionId: session.sessionId,
          })
          .catch((err: unknown) =>
            log.warn("Could not record the prompt in history", { error: err }),
          );
      }
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
    const forkFrom = message.forkFrom;
    if (forkFrom && !isUuid(forkFrom.sessionId)) throw new Error("Invalid session id");
    const creation = this.create(message.worktreePath, resumeId, forkFrom);
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
    forkFrom: { sessionId: string; at?: string } | undefined,
  ): Promise<{ session: AgentSession; resume: boolean }> {
    const [resumed, starting] = await Promise.all([
      resumeId ? this.deps.loadHistory(resumeId) : null,
      this.deps.startingEvents(worktreePath).catch(() => []),
    ]);
    // A session that never got a message has no transcript: a fork starts from its source
    // again, anything else afresh under its own id.
    const forked =
      resumed === null && forkFrom
        ? await this.deps.loadHistory(forkFrom.sessionId, forkFrom.at)
        : null;
    const resume = resumed !== null;
    const sessionId = resumeId ?? crypto.randomUUID();
    const session = new AgentSession(
      { worktreePath, sessionId, resume, ...(forked !== null && forkFrom ? { forkFrom } : {}) },
      this.deps.createTransport,
      [...starting, ...(resumed ?? forked ?? [])],
    );
    return { session, resume };
  }

  /** Resumes, forks or continues another session in a panel. */
  private async openSession(
    session: AgentSession,
    message: Extract<AgentClientMessage, { type: "open_session" }>,
  ): Promise<void> {
    let target = message.sessionId;
    if (message.action === "continue") {
      const sessions = await this.deps.listSessions(session.worktreePath);
      target = sessions.find((s) => s.id !== session.sessionId)?.id;
      if (!target) throw new Error("There is no earlier session in this worktree to continue");
    }
    if (!target || !isUuid(target)) throw new Error("Invalid session id");
    const history = await this.deps.loadHistory(target);
    if (history === null) throw new Error("That session has no conversation to open");
    const worktreePath = session.worktreePath;
    await session.switchTo(
      message.action === "fork"
        ? {
            worktreePath,
            sessionId: crypto.randomUUID(),
            resume: false,
            forkFrom: { sessionId: target },
          }
        : { worktreePath, sessionId: target, resume: true },
      history,
    );
  }
}
