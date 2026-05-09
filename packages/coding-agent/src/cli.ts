import {
  createResult,
  formatKeyValue,
  formatTable,
  runAction,
  Command,
} from "@bizimind/cli-common";
import { createLogger, createNoopLogger, type AppLogger } from "@bizimind/logger";

import { CodingAgentRuntime } from "./orchestrator/runtime.ts";
import { protocolRequestSchema } from "./protocol/schemas.ts";
import { SessionStore } from "./session/store.ts";
import { getCurrentVersion } from "./version.ts";

interface GlobalOptions {
  json?: boolean;
}

interface SessionRefOptions extends GlobalOptions {
  sessionId: string;
  messageId?: string;
}

function printLine(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function createRuntimeLogger(noLog: boolean): AppLogger {
  if (noLog) {
    return createNoopLogger().with({ component: "cli-runtime" });
  }

  const axiomToken = process.env.AXIOM_TOKEN;
  const axiomDataset = process.env.AXIOM_DATASET;

  if (axiomToken && axiomDataset) {
    return createLogger({ source: "coding-agent", mode: "http", axiomToken, axiomDataset }).with({
      component: "cli-runtime",
    });
  }

  // Avoid console logger for stdio protocol mode because stdout is reserved for protocol events.
  return createNoopLogger().with({ component: "cli-runtime" });
}

async function runJsonProtocolServer(noLog: boolean): Promise<void> {
  const logger = createRuntimeLogger(noLog);
  const runtime = new CodingAgentRuntime(
    {
      emit: async (event) => {
        printLine(event);
      },
    },
    logger,
  );

  runtime.on("error", (diagnostic) => {
    logger.error("Runtime diagnostic", { diagnostic });
  });

  const input = process.stdin;
  input.setEncoding("utf8");

  try {
    let buffer = "";
    for await (const chunk of input) {
      buffer += chunk;

      let index = buffer.indexOf("\n");
      while (index !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);

        if (line.length > 0) {
          try {
            const payload = JSON.parse(line) as unknown;
            const request = protocolRequestSchema.parse(payload);
            logger.debug("Received protocol request", {
              requestType: request.type,
              requestId: request.request_id,
              sessionId: "session_id" in request ? request.session_id : undefined,
            });
            await runtime.handleRequest(request);
          } catch (error) {
            logger.error("Failed to process protocol request line", { error });
            printLine({
              type: "run.failed",
              session_id: "unknown",
              timestamp: new Date().toISOString(),
              payload: { message: error instanceof Error ? error.message : String(error), line },
            });
          }
        }

        index = buffer.indexOf("\n");
      }
    }
  } finally {
    await logger.flush();
  }
}

function listSessions(opts: GlobalOptions): void {
  const store = new SessionStore();

  void runAction(opts, async () => {
    const sessions = await store.listSessions();
    return createResult(sessions, (rows) => {
      if (rows.length === 0) {
        return "No sessions found.";
      }
      return formatTable(
        rows.map((row) => ({
          id: row.id,
          mode: row.mode,
          profile: row.profile,
          activeBranchId: row.activeBranchId,
          updatedAt: row.updatedAt,
        })),
        [
          { key: "id", label: "Session ID" },
          { key: "mode", label: "Mode" },
          { key: "profile", label: "Profile" },
          { key: "activeBranchId", label: "Branch" },
          { key: "updatedAt", label: "Updated" },
        ],
      );
    });
  });
}

function getSession(opts: SessionRefOptions): void {
  const store = new SessionStore();

  void runAction(opts, async () => {
    const session = await store.loadSession(opts.sessionId);
    return createResult(session, (item) =>
      formatKeyValue({
        session: item.id,
        workspace: item.workspaceRoot,
        mode: item.state.mode,
        profile: item.state.profile,
        activeBranch: item.activeBranchId,
        activeMessage: item.activeMessageId ?? "-",
      }),
    );
  });
}

function resumeSession(opts: SessionRefOptions): void {
  const store = new SessionStore();

  void runAction(opts, async () => {
    const session = opts.messageId
      ? await store.rewind(opts.sessionId, opts.messageId)
      : await store.loadSession(opts.sessionId);

    return createResult(
      {
        sessionId: session.id,
        activeBranchId: session.activeBranchId,
        activeMessageId: session.activeMessageId,
      },
      (data) =>
        formatKeyValue({
          session: data.sessionId,
          activeBranch: data.activeBranchId,
          activeMessage: data.activeMessageId ?? "-",
        }),
    );
  });
}

function forkSession(opts: SessionRefOptions): void {
  const store = new SessionStore();

  void runAction(opts, async () => {
    const forked = await store.fork(opts.sessionId, opts.messageId);

    return createResult(
      {
        sessionId: forked.id,
        parentSessionId: forked.lineage.parentSessionId,
        forkPointMessageId: forked.lineage.forkPointMessageId,
      },
      (data) =>
        formatKeyValue({
          forkSession: data.sessionId,
          parent: data.parentSessionId ?? "-",
          forkPoint: data.forkPointMessageId ?? "-",
        }),
    );
  });
}

function compactSession(opts: SessionRefOptions): void {
  const store = new SessionStore();

  void runAction(opts, async () => {
    const compacted = await store.compact(opts.sessionId);
    const latest = compacted.compactions.at(-1);

    return createResult(
      {
        sessionId: compacted.id,
        compactionId: latest?.id ?? "-",
        replacementMessageId: latest?.replacementMessageId ?? "-",
      },
      (data) =>
        formatKeyValue({
          session: data.sessionId,
          compaction: data.compactionId,
          replacementMessage: data.replacementMessageId,
        }),
    );
  });
}

const program = new Command();
program
  .name("coding-agent")
  .description("Programmatic coding agent runtime")
  .version(getCurrentVersion());

const agent = program.command("agent").description("Agent runtime operations");
agent
  .command("run")
  .description("Start stdio JSON-stream protocol server")
  .option("--no-log", "Disable Axiom logging")
  .action(async (opts: { log: boolean }) => {
    await runJsonProtocolServer(!opts.log);
  });

const session = program.command("session").description("Session management");
session
  .command("list")
  .description("List sessions")
  .option("-j, --json", "Output as JSON")
  .action((opts: GlobalOptions) => listSessions(opts));

session
  .command("get")
  .description("Get session details")
  .requiredOption("--session-id <id>", "Session ID")
  .option("-j, --json", "Output as JSON")
  .action((opts: SessionRefOptions) => getSession(opts));

session
  .command("resume")
  .description("Resume a session, optionally rewinding to a specific message")
  .requiredOption("--session-id <id>", "Session ID")
  .option("--message-id <id>", "Optional rewind message ID")
  .option("-j, --json", "Output as JSON")
  .action((opts: SessionRefOptions) => resumeSession(opts));

session
  .command("fork")
  .description("Fork a session at optional message boundary")
  .requiredOption("--session-id <id>", "Session ID")
  .option("--message-id <id>", "Optional fork point message ID")
  .option("-j, --json", "Output as JSON")
  .action((opts: SessionRefOptions) => forkSession(opts));

session
  .command("compact")
  .description("Compact active context for a session")
  .requiredOption("--session-id <id>", "Session ID")
  .option("-j, --json", "Output as JSON")
  .action((opts: SessionRefOptions) => compactSession(opts));

await program.parseAsync(process.argv);
