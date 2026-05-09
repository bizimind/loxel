import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import type { ToolProfile } from "../tools/profile.ts";

import {
  ensureSessionLayout,
  ensureStateLayout,
  getSessionPaths,
  getStateLayout,
} from "../state/layout.ts";
import {
  createBranchId,
  createCompactionId,
  createEventId,
  createMessageId,
  createPlanFileName,
  createSessionId,
} from "../utils/ids.ts";
import { appendJsonl, readJsonl } from "../utils/jsonl.ts";
import { asRecord } from "../utils/record.ts";
import { redactSecrets } from "../utils/redaction.ts";
import {
  agentControlledStateSchema,
  createDefaultReminderState,
  type AgentControlledState,
  type SessionEvent,
  type SessionEventScope,
  type SessionMessage,
  type SessionMode,
  type SessionRecord,
  sessionBranchSchema,
  sessionEventSchema,
  sessionMessageSchema,
  sessionRecordSchema,
} from "./model.ts";

export interface CreateSessionOptions {
  workspaceRoot: string;
  sessionId?: string;
  profile?: ToolProfile;
  mode?: SessionMode;
  promptProfile?: string;
  declaredTools?: string[] | null;
  parentSessionId?: string | null;
  forkPointMessageId?: string | null;
  rootBranchId?: string;
}

export interface SessionSummary {
  id: string;
  createdAt: string;
  updatedAt: string;
  mode: SessionMode;
  profile: ToolProfile;
  activeBranchId: string;
  activeMessageId: string | null;
}

interface AppendEventOptions {
  requestId?: string;
  runId?: string;
  scope?: SessionEventScope;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function nowIso(): string {
  return new Date().toISOString();
}

function createDefaultState(mode: SessionMode, profile: ToolProfile): AgentControlledState {
  return {
    mode,
    profile,
    plan: { planFilePath: null, steps: [], approved: false },
    todos: [],
    reminders: createDefaultReminderState(),
  };
}

function parseSubagentStatus(
  value: unknown,
): "queued" | "running" | "completed" | "failed" | "cancelled" {
  if (
    value === "queued" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  ) {
    return value;
  }
  return "running";
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const where = issue.path.length > 0 ? issue.path.join(".") : "root";
      return `${where}: ${issue.message}`;
    })
    .join("; ");
}

function parseOrThrow<T>(
  schema: z.ZodType<T>,
  value: unknown,
  context: string,
  event: SessionEvent,
): T {
  const result = schema.safeParse(value);
  if (result.success) {
    return result.data;
  }

  throw new Error(
    `Cannot replay session ${event.sessionId}: invalid ${context} in event ${event.id}: ${formatZodIssues(result.error)}`,
  );
}

export class SessionStore {
  private readonly sessionWriteQueue = new Map<string, Promise<void>>();

  private enqueueSessionWrite<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionWriteQueue.get(sessionId) ?? Promise.resolve();
    const run = previous.then(operation, operation);
    this.sessionWriteQueue.set(
      sessionId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private async appendEventInternal(
    sessionId: string,
    type: string,
    payload: Record<string, unknown>,
    options?: AppendEventOptions,
  ): Promise<SessionEvent> {
    const paths = await ensureSessionLayout(sessionId);
    await mkdir(path.dirname(paths.eventsFile), { recursive: true });

    const event: SessionEvent = {
      id: createEventId(),
      sessionId,
      timestamp: nowIso(),
      type,
      payload: redactSecrets(payload),
      requestId: options?.requestId,
      runId: options?.runId,
      scope: options?.scope,
    };

    await appendJsonl(paths.eventsFile, event);
    return event;
  }

  private async appendMessageInternal(
    current: SessionRecord,
    role: SessionMessage["role"],
    content: unknown,
    runId: string | null,
  ): Promise<SessionMessage> {
    const message: SessionMessage = {
      id: createMessageId(),
      branchId: current.activeBranchId,
      parentMessageId: current.activeMessageId,
      role,
      content,
      createdAt: nowIso(),
      runId,
    };

    await this.appendEventInternal(current.id, "message.appended", { message });
    return message;
  }

  private async setStateInternal(
    current: SessionRecord,
    nextState: AgentControlledState,
  ): Promise<void> {
    const validated = agentControlledStateSchema.parse(deepClone(nextState));
    await this.appendEventInternal(current.id, "state.updated", {
      activeMessageId: current.activeMessageId,
      state: validated,
    });
  }

  private async createBranchFromMessageInternal(
    current: SessionRecord,
    fromMessageId: string,
    label: string,
  ): Promise<string> {
    const sourceMessage = current.messages[fromMessageId];
    if (!sourceMessage) {
      throw new Error(`Unknown message id: ${fromMessageId}`);
    }

    const newBranchId = createBranchId();
    const branch = {
      id: newBranchId,
      parentBranchId: sourceMessage.branchId,
      forkedFromMessageId: fromMessageId,
      createdAt: nowIso(),
      label,
    };

    await this.appendEventInternal(current.id, "branch.created", { branch, fromMessageId, label });
    return newBranchId;
  }

  async createSession(options: CreateSessionOptions): Promise<SessionRecord> {
    await ensureStateLayout();

    const sessionId = options.sessionId ?? createSessionId();
    const profile = options.profile ?? "execute";
    const mode = options.mode ?? (profile === "plan" ? "plan" : "execute");
    const createdAt = nowIso();
    const rootBranchId = options.rootBranchId ?? createBranchId();
    await ensureSessionLayout(sessionId);
    const layout = getStateLayout();

    const defaultState = createDefaultState(mode, profile);
    if (mode === "plan") {
      const planPath = path.join(layout.plansDir, createPlanFileName());
      await Bun.write(planPath, "# Plan\n\n");
      defaultState.plan.planFilePath = planPath;
    }

    const record: SessionRecord = {
      id: sessionId,
      workspaceRoot: options.workspaceRoot,
      createdAt,
      updatedAt: createdAt,
      activeBranchId: rootBranchId,
      activeMessageId: null,
      branches: {
        [rootBranchId]: {
          id: rootBranchId,
          parentBranchId: null,
          forkedFromMessageId: null,
          createdAt,
          label: "main",
        },
      },
      branchHeads: { [rootBranchId]: null },
      messages: {},
      snapshots: {},
      state: defaultState,
      compactions: [],
      approvals: [],
      contextReplacementMessageId: null,
      promptProfile: options.promptProfile ?? "default",
      declaredTools: options.declaredTools ?? null,
      lineage: {
        parentSessionId: options.parentSessionId ?? null,
        forkPointMessageId: options.forkPointMessageId ?? null,
      },
      subagents: {},
    };

    await this.appendEvent(record.id, "session.created", {
      sessionId: record.id,
      mode,
      profile,
      rootBranchId,
      workspaceRoot: record.workspaceRoot,
      promptProfile: record.promptProfile,
      declaredTools: record.declaredTools,
      parentSessionId: record.lineage.parentSessionId,
      forkPointMessageId: record.lineage.forkPointMessageId,
      planFilePath: record.state.plan.planFilePath,
    });

    if (record.state.plan.planFilePath) {
      await this.appendEvent(record.id, "plan.created", {
        plan_file_path: record.state.plan.planFilePath,
      });
    }

    return this.loadSession(record.id);
  }

  async loadSession(sessionId: string): Promise<SessionRecord> {
    return this.replayFromEvents(sessionId);
  }

  async listSessions(): Promise<SessionSummary[]> {
    await ensureStateLayout();
    const layout = getStateLayout();
    try {
      const st = await stat(layout.sessionsDir);
      if (!st.isDirectory()) {
        return [];
      }
    } catch {
      return [];
    }

    const result: SessionSummary[] = [];
    const dirs = await readdir(layout.sessionsDir);
    for (const dir of dirs) {
      const eventsFile = Bun.file(path.join(layout.sessionsDir, dir, "events.jsonl"));
      if (!(await eventsFile.exists())) {
        continue;
      }

      const record = await this.replayFromEvents(dir);
      result.push({
        id: record.id,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        mode: record.state.mode,
        profile: record.state.profile,
        activeBranchId: record.activeBranchId,
        activeMessageId: record.activeMessageId,
      });
    }

    return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async appendEvent(
    sessionId: string,
    type: string,
    payload: Record<string, unknown>,
    options?: AppendEventOptions,
  ): Promise<SessionEvent> {
    return this.enqueueSessionWrite(sessionId, () =>
      this.appendEventInternal(sessionId, type, payload, options),
    );
  }

  async readEvents(sessionId: string): Promise<SessionEvent[]> {
    const paths = getSessionPaths(sessionId);
    const rows = await readJsonl<unknown>(paths.eventsFile);
    const events: SessionEvent[] = [];

    for (let index = 0; index < rows.length; index += 1) {
      const parsed = sessionEventSchema.safeParse(rows[index]);
      if (parsed.success) {
        events.push(parsed.data);
        continue;
      }

      throw new Error(
        `Invalid session event at line ${index + 1} in ${paths.eventsFile}: ${formatZodIssues(parsed.error)}`,
      );
    }

    return events;
  }

  private async appendClonedEvent(
    sessionId: string,
    event: SessionEvent,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const paths = await ensureSessionLayout(sessionId);
    await mkdir(path.dirname(paths.eventsFile), { recursive: true });

    const cloned: SessionEvent = {
      id: createEventId(),
      sessionId,
      timestamp: event.timestamp,
      type: event.type,
      payload: redactSecrets(payload),
      requestId: event.requestId,
      runId: event.runId,
      scope: event.scope,
    };

    await appendJsonl(paths.eventsFile, cloned);
  }

  async appendMessage(
    record: SessionRecord,
    role: SessionMessage["role"],
    content: unknown,
    runId: string | null,
  ): Promise<SessionMessage> {
    return this.enqueueSessionWrite(record.id, async () => {
      const current = await this.loadSession(record.id);
      return this.appendMessageInternal(current, role, content, runId);
    });
  }

  async setState(record: SessionRecord, nextState: AgentControlledState): Promise<void> {
    await this.enqueueSessionWrite(record.id, async () => {
      const current = await this.loadSession(record.id);
      await this.setStateInternal(current, nextState);
    });
  }

  async createBranchFromMessage(
    record: SessionRecord,
    fromMessageId: string,
    label: string,
  ): Promise<string> {
    return this.enqueueSessionWrite(record.id, async () => {
      const current = await this.loadSession(record.id);
      return this.createBranchFromMessageInternal(current, fromMessageId, label);
    });
  }

  async rewind(sessionId: string, messageId: string): Promise<SessionRecord> {
    return this.enqueueSessionWrite(sessionId, async () => {
      const record = await this.loadSession(sessionId);
      if (!record.messages[messageId]) {
        throw new Error(`Message ID not found: ${messageId} (session: ${sessionId})`);
      }

      const rewindFrom = record.activeMessageId;
      const branchId = await this.createBranchFromMessageInternal(record, messageId, "rewind");

      await this.appendEventInternal(record.id, "session.rewound", {
        rewindFrom,
        rewindTo: messageId,
        activeBranchId: branchId,
      });

      return this.loadSession(sessionId);
    });
  }

  async fork(sessionId: string, messageId?: string): Promise<SessionRecord> {
    return this.enqueueSessionWrite(sessionId, async () => {
      const source = await this.loadSession(sessionId);
      const forkPointMessageId = messageId ?? source.activeMessageId ?? null;
      if (forkPointMessageId && !source.messages[forkPointMessageId]) {
        throw new Error(`Message ID not found: ${forkPointMessageId} (session: ${sessionId})`);
      }

      const forkedSessionId = createSessionId();
      await ensureSessionLayout(forkedSessionId);

      const sourceEvents = await this.readEvents(source.id);
      for (const event of sourceEvents) {
        const payload = deepClone(event.payload);
        if (event.type === "session.created") {
          payload.sessionId = forkedSessionId;
          payload.parentSessionId = source.id;
          payload.forkPointMessageId = forkPointMessageId;
        }
        await this.appendClonedEvent(forkedSessionId, event, payload);
      }

      return this.loadSession(forkedSessionId);
    });
  }

  private collectActiveChain(record: SessionRecord): SessionMessage[] {
    const chain: SessionMessage[] = [];
    let cursor = record.activeMessageId;

    while (cursor) {
      const message = record.messages[cursor];
      if (!message) {
        break;
      }
      chain.push(message);
      cursor = message.parentMessageId;
    }

    chain.reverse();
    return chain;
  }

  async compact(sessionId: string): Promise<SessionRecord> {
    return this.enqueueSessionWrite(sessionId, async () => {
      const record = await this.loadSession(sessionId);
      const chain = this.collectActiveChain(record);
      const paths = await ensureSessionLayout(sessionId);

      const sourceMessageIds = chain.map((msg) => msg.id);
      const summary = chain
        .slice(-12)
        .map((msg) => `${msg.role}: ${String(msg.content).slice(0, 140)}`)
        .join("\n");
      const files = Array.from(
        new Set(
          chain
            .map((msg) => {
              const contentRecord = asRecord(msg.content);
              if (!contentRecord) {
                return null;
              }
              const candidate = contentRecord.file_path;
              return typeof candidate === "string" ? candidate : null;
            })
            .filter((value): value is string => Boolean(value)),
        ),
      );

      const replacementMessage = await this.appendMessageInternal(
        record,
        "system",
        {
          type: "compaction_summary",
          summary,
          sourceMessageIds,
          planPath: record.state.plan.planFilePath,
          promptProfile: record.promptProfile,
        },
        null,
      );

      const refreshed = await this.loadSession(record.id);
      const nextState = deepClone(refreshed.state);
      nextState.reminders.activeConditions.context_compacted = true;
      nextState.reminders.cooldowns.context_compacted = 6;
      await this.setStateInternal(refreshed, nextState);

      const compactionId = createCompactionId();
      const compactionArtifactPath = path.join(paths.compactionsDir, `${compactionId}.json`);
      const createdAt = nowIso();
      await Bun.write(
        compactionArtifactPath,
        `${JSON.stringify(
          {
            compactionId,
            sourceRange: sourceMessageIds,
            summary,
            filesTouched: files,
            plan: {
              path: refreshed.state.plan.planFilePath,
              approved: refreshed.state.plan.approved,
              steps: refreshed.state.plan.steps,
            },
            promptProfile: refreshed.promptProfile,
            createdAt,
          },
          null,
          2,
        )}\n`,
      );

      await this.appendEventInternal(record.id, "context.compaction.completed", {
        compactionId,
        sourceRange: sourceMessageIds,
        activeReplacementPointer: replacementMessage.id,
        compactionArtifactPath,
        summary,
        filesTouched: files,
        planSnapshot: refreshed.state.plan.planFilePath,
        promptProfile: refreshed.promptProfile,
        createdAt,
      });

      return this.loadSession(record.id);
    });
  }

  async replayFromEvents(sessionId: string): Promise<SessionRecord> {
    const events = await this.readEvents(sessionId);
    const created = events.find((event) => event.type === "session.created");
    if (!created) {
      throw new Error(`Session ID not found: ${sessionId}`);
    }

    const createdPayload = parseOrThrow(
      z
        .object({
          sessionId: z.string().optional(),
          mode: z.enum(["execute", "plan"]),
          profile: z.enum(["execute", "plan", "minimal"]),
          rootBranchId: z.string(),
          workspaceRoot: z.string(),
          promptProfile: z.string().optional(),
          declaredTools: z.array(z.string()).nullable().optional(),
          parentSessionId: z.string().nullable().optional(),
          forkPointMessageId: z.string().nullable().optional(),
          planFilePath: z.string().nullable().optional(),
        })
        .passthrough(),
      created.payload,
      "session.created payload",
      created,
    );

    const rootBranchId = createdPayload.rootBranchId;
    const mode = createdPayload.mode;
    const profile = createdPayload.profile;
    const workspaceRoot = createdPayload.workspaceRoot;

    const state = createDefaultState(mode, profile);
    if (typeof createdPayload.planFilePath === "string") {
      state.plan.planFilePath = createdPayload.planFilePath;
    }

    const record: SessionRecord = {
      id: sessionId,
      workspaceRoot,
      createdAt: created.timestamp,
      updatedAt: created.timestamp,
      activeBranchId: rootBranchId,
      activeMessageId: null,
      branches: {
        [rootBranchId]: {
          id: rootBranchId,
          parentBranchId: null,
          forkedFromMessageId: null,
          createdAt: created.timestamp,
          label: "main",
        },
      },
      branchHeads: { [rootBranchId]: null },
      messages: {},
      snapshots: {},
      state,
      compactions: [],
      approvals: [],
      contextReplacementMessageId: null,
      promptProfile: createdPayload.promptProfile ?? "default",
      declaredTools: createdPayload.declaredTools ?? null,
      lineage: {
        parentSessionId: createdPayload.parentSessionId ?? null,
        forkPointMessageId: createdPayload.forkPointMessageId ?? null,
      },
      subagents: {},
    };

    for (const event of events) {
      record.updatedAt = event.timestamp;
      if (event.id === created.id) {
        continue;
      }

      if (event.type === "message.appended") {
        const payload = parseOrThrow(
          z.object({ message: sessionMessageSchema }).passthrough(),
          event.payload,
          "message.appended payload",
          event,
        );
        const message = payload.message;
        if (!record.branches[message.branchId]) {
          throw new Error(
            `Cannot replay session ${sessionId}: message ${message.id} references unknown branch ${message.branchId} in event ${event.id}`,
          );
        }

        record.messages[message.id] = message;
        record.activeMessageId = message.id;
        record.activeBranchId = message.branchId;
        record.branchHeads[message.branchId] = message.id;
        record.snapshots[message.id] = deepClone(record.state);
        continue;
      }

      if (event.type === "branch.created") {
        const payload = parseOrThrow(
          z
            .object({
              branch: sessionBranchSchema,
              fromMessageId: z.string().nullable().optional(),
            })
            .passthrough(),
          event.payload,
          "branch.created payload",
          event,
        );
        const branch = payload.branch;
        record.branches[branch.id] = branch;

        const fromMessageId = payload.fromMessageId ?? null;
        if (fromMessageId) {
          if (!record.messages[fromMessageId]) {
            throw new Error(
              `Cannot replay session ${sessionId}: branch ${branch.id} references unknown fromMessageId ${fromMessageId} in event ${event.id}`,
            );
          }
          record.branchHeads[branch.id] = fromMessageId;
          record.activeBranchId = branch.id;
          record.activeMessageId = fromMessageId;
          const snapshot = record.snapshots[fromMessageId];
          if (!snapshot) {
            throw new Error(
              `Cannot replay session ${sessionId}: missing state snapshot for branch anchor ${fromMessageId} in event ${event.id}`,
            );
          }
          record.state = deepClone(snapshot);
        } else if (!(branch.id in record.branchHeads)) {
          record.branchHeads[branch.id] = null;
        }
        continue;
      }

      if (event.type === "state.updated") {
        const payload = parseOrThrow(
          z
            .object({
              activeMessageId: z.string().nullable().optional(),
              state: agentControlledStateSchema,
            })
            .passthrough(),
          event.payload,
          "state.updated payload",
          event,
        );

        record.state = deepClone(payload.state);
        const anchorMessageId = payload.activeMessageId ?? record.activeMessageId;
        if (anchorMessageId) {
          if (!record.messages[anchorMessageId]) {
            throw new Error(
              `Cannot replay session ${sessionId}: state.updated references unknown activeMessageId ${anchorMessageId} in event ${event.id}`,
            );
          }
          record.snapshots[anchorMessageId] = deepClone(record.state);
        }
        continue;
      }

      if (event.type === "session.rewound") {
        const payload = parseOrThrow(
          z
            .object({
              rewindFrom: z.string().nullable().optional(),
              rewindTo: z.string(),
              activeBranchId: z.string(),
            })
            .passthrough(),
          event.payload,
          "session.rewound payload",
          event,
        );

        if (!record.branches[payload.activeBranchId]) {
          throw new Error(
            `Cannot replay session ${sessionId}: session.rewound references unknown branch ${payload.activeBranchId} in event ${event.id}`,
          );
        }
        if (!record.messages[payload.rewindTo]) {
          throw new Error(
            `Cannot replay session ${sessionId}: session.rewound references unknown message ${payload.rewindTo} in event ${event.id}`,
          );
        }
        const snapshot = record.snapshots[payload.rewindTo];
        if (!snapshot) {
          throw new Error(
            `Cannot replay session ${sessionId}: missing state snapshot for rewind target ${payload.rewindTo} in event ${event.id}`,
          );
        }
        record.activeBranchId = payload.activeBranchId;
        record.activeMessageId = payload.rewindTo;
        record.state = deepClone(snapshot);
        continue;
      }

      if (event.type === "context.compaction.completed") {
        const payload = parseOrThrow(
          z
            .object({
              compactionId: z.string(),
              sourceRange: z.array(z.string()),
              activeReplacementPointer: z.string(),
              compactionArtifactPath: z.string().optional(),
              summary: z.string().optional(),
              filesTouched: z.array(z.string()).optional(),
              planSnapshot: z.string().nullable().optional(),
              promptProfile: z.string().optional(),
              createdAt: z.string().optional(),
            })
            .passthrough(),
          event.payload,
          "context.compaction.completed payload",
          event,
        );

        if (!record.messages[payload.activeReplacementPointer]) {
          throw new Error(
            `Cannot replay session ${sessionId}: compaction replacement message ${payload.activeReplacementPointer} is missing in event ${event.id}`,
          );
        }
        record.contextReplacementMessageId = payload.activeReplacementPointer;

        if (!record.compactions.some((entry) => entry.id === payload.compactionId)) {
          record.compactions.push({
            id: payload.compactionId,
            sourceMessageIds: payload.sourceRange,
            summary: payload.summary ?? "",
            files: payload.filesTouched ?? [],
            planSnapshot: payload.planSnapshot ?? null,
            promptProfile: payload.promptProfile ?? record.promptProfile,
            createdAt: payload.createdAt ?? event.timestamp,
            replacementMessageId: payload.activeReplacementPointer,
          });
        }
        continue;
      }

      if (event.type === "approval.decision.recorded") {
        const payload = parseOrThrow(
          z
            .object({
              id: z.string(),
              timestamp: z.string(),
              toolName: z.string(),
              decision: z.enum(["allow", "allow_this_session", "allow_always", "deny"]),
              input: z.unknown(),
            })
            .passthrough(),
          event.payload,
          "approval.decision.recorded payload",
          event,
        );

        record.approvals.push({
          id: payload.id,
          timestamp: payload.timestamp,
          toolName: payload.toolName,
          decision: payload.decision,
          input: payload.input,
        });
        continue;
      }

      if (event.type === "session.forked") {
        const payload = parseOrThrow(
          z
            .object({
              parentSessionId: z.string().nullable().optional(),
              forkPointMessageId: z.string().nullable().optional(),
              activeBranchId: z.string().optional(),
            })
            .passthrough(),
          event.payload,
          "session.forked payload",
          event,
        );

        if (payload.parentSessionId) {
          record.lineage.parentSessionId = payload.parentSessionId;
        }
        if (payload.forkPointMessageId) {
          record.lineage.forkPointMessageId = payload.forkPointMessageId;
        }
        if (payload.activeBranchId) {
          if (!record.branches[payload.activeBranchId]) {
            throw new Error(
              `Cannot replay session ${sessionId}: session.forked references unknown branch ${payload.activeBranchId} in event ${event.id}`,
            );
          }
          record.activeBranchId = payload.activeBranchId;
        }
        continue;
      }

      if (event.type === "subagent.session.started") {
        const payload = parseOrThrow(
          z
            .object({
              subagent_id: z.string(),
              status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
              parent_agent_id: z.string().nullable().optional(),
              created_at: z.string().optional(),
              description: z.string().nullable().optional(),
              subagent_type: z.string().nullable().optional(),
              model: z.string().nullable().optional(),
              resumed_from_task_id: z.string().nullable().optional(),
            })
            .passthrough(),
          event.payload,
          "subagent.session.started payload",
          event,
        );
        const parentAgentId = payload.parent_agent_id ?? event.scope?.parentAgentId ?? "main";

        record.subagents[payload.subagent_id] = {
          id: payload.subagent_id,
          parentAgentId,
          status: parseSubagentStatus(payload.status),
          description: payload.description ?? null,
          subagentType: payload.subagent_type ?? null,
          model: payload.model ?? null,
          createdAt: payload.created_at ?? event.timestamp,
          updatedAt: event.timestamp,
          resumedFromTaskId: payload.resumed_from_task_id ?? null,
        };
        continue;
      }

      if (event.type === "subagent.session.updated") {
        const payload = parseOrThrow(
          z
            .object({
              subagent_id: z.string(),
              status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
            })
            .passthrough(),
          event.payload,
          "subagent.session.updated payload",
          event,
        );

        const existing = record.subagents[payload.subagent_id];
        if (!existing) {
          record.subagents[payload.subagent_id] = {
            id: payload.subagent_id,
            parentAgentId: event.scope?.parentAgentId ?? "main",
            status: parseSubagentStatus(payload.status),
            description: null,
            subagentType: null,
            model: null,
            createdAt: event.timestamp,
            updatedAt: event.timestamp,
            resumedFromTaskId: null,
          };
          continue;
        }

        existing.status = parseSubagentStatus(payload.status);
        existing.updatedAt = event.timestamp;
      }
    }

    return sessionRecordSchema.parse(record);
  }

  getMessagesForModel(record: SessionRecord): SessionMessage[] {
    const chain = this.collectActiveChain(record);

    if (!record.contextReplacementMessageId) {
      return chain;
    }

    const startIndex = chain.findIndex((msg) => msg.id === record.contextReplacementMessageId);
    if (startIndex === -1) {
      return chain;
    }

    return chain.slice(startIndex);
  }
}
