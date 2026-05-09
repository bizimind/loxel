import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { ApprovalDecision, PermissionFile, PermissionRule } from "./model.ts";

import { ensureStateLayout, getStateLayout } from "../state/layout.ts";
import { permissionFileSchema } from "./model.ts";

const EMPTY_FILE: PermissionFile = { version: 1, updatedAt: new Date(0).toISOString(), rules: [] };
const writeQueueByFile = new Map<string, Promise<void>>();

function hashWorkspace(workspaceRoot: string): string {
  return createHash("sha256").update(workspaceRoot).digest("hex");
}

/** File-mutation tools that share a single workspace-scoped permission. */
const FILE_WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

/**
 * Per-tool allowlist of input keys that define the action's identity for fingerprinting.
 * Only these fields are hashed — metadata like `description` or `timeout` that the model may
 * vary between identical calls are excluded so persisted permissions match correctly.
 * Tools not listed here (and not in FILE_WRITE_TOOLS) use the full input object.
 */
const fingerprintKeys: Partial<Record<string, string[]>> = {
  Bash: ["command", "dangerouslyDisableSandbox"],
  ExitPlanMode: ["allowedPrompts", "pushToRemote"],
};

function isWithinWorkspace(filePath: string, workspaceRoot: string): boolean {
  const resolved = path.resolve(workspaceRoot, filePath);
  return resolved === workspaceRoot || resolved.startsWith(workspaceRoot + path.sep);
}

function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

async function readPermissionFile(filePath: string): Promise<PermissionFile> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return EMPTY_FILE;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await file.text()) as unknown;
  } catch {
    return EMPTY_FILE;
  }
  const parsed = permissionFileSchema.safeParse(payload);
  if (!parsed.success) {
    return EMPTY_FILE;
  }
  return parsed.data;
}

async function writePermissionFile(filePath: string, data: PermissionFile): Promise<void> {
  await Bun.write(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

export class PermissionStore {
  constructor(
    private readonly workspaceRoot: string,
    private readonly sessionId: string,
  ) {}

  private async getProjectFilePath(): Promise<string> {
    const layout = getStateLayout();
    await ensureStateLayout();
    await mkdir(layout.permissionsProjectDir, { recursive: true });
    return path.join(layout.permissionsProjectDir, `${hashWorkspace(this.workspaceRoot)}.json`);
  }

  private async getSessionFilePath(): Promise<string> {
    const layout = getStateLayout();
    await ensureStateLayout();
    await mkdir(layout.permissionsSessionDir, { recursive: true });
    return path.join(layout.permissionsSessionDir, `${this.sessionId}.json`);
  }

  /**
   * Resolve the canonical tool name and fingerprint used for permission matching.
   *
   * - Edit/Write/MultiEdit within the workspace share a single "FileWrite" permission so that
   *   approving any one approves all file mutations in the workspace.
   * - Bash only hashes `command` + `dangerouslyDisableSandbox`, ignoring `description`/`timeout`.
   * - Other tools hash the full input.
   */
  private resolvePermissionKey(
    tool: string,
    input: unknown,
  ): { tool: string; fingerprint: string } {
    if (FILE_WRITE_TOOLS.has(tool) && typeof input === "object" && input !== null) {
      const filePath = (input as Record<string, unknown>).file_path;
      if (typeof filePath === "string" && isWithinWorkspace(filePath, this.workspaceRoot)) {
        return {
          tool: "FileWrite",
          fingerprint: sha256(JSON.stringify(["FileWrite", "workspace"])),
        };
      }
    }

    const keys = fingerprintKeys[tool];
    let payload: unknown = input;
    if (keys && typeof input === "object" && input !== null) {
      const record = input as Record<string, unknown>;
      const picked: Record<string, unknown> = {};
      for (const key of keys) {
        if (key in record) picked[key] = record[key];
      }
      payload = picked;
    }

    return { tool, fingerprint: sha256(JSON.stringify([tool, payload])) };
  }

  private enqueueWrite<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
    const previous = writeQueueByFile.get(filePath) ?? Promise.resolve();
    const run = previous.then(operation, operation);
    writeQueueByFile.set(
      filePath,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  async isAllowed(tool: string, input: unknown): Promise<boolean | undefined> {
    const key = this.resolvePermissionKey(tool, input);

    const [sessionFilePath, projectFilePath] = await Promise.all([
      this.getSessionFilePath(),
      this.getProjectFilePath(),
    ]);

    const [sessionData, projectData] = await Promise.all([
      readPermissionFile(sessionFilePath),
      readPermissionFile(projectFilePath),
    ]);

    const matches = (rule: PermissionRule) =>
      rule.tool === key.tool && rule.fingerprint === key.fingerprint;

    if (sessionData.rules.some(matches)) return true;
    if (projectData.rules.some(matches)) return true;

    return undefined;
  }

  async persistDecision(tool: string, input: unknown, decision: ApprovalDecision): Promise<void> {
    if (decision !== "allow_this_session" && decision !== "allow_always") {
      return;
    }

    const targetPath =
      decision === "allow_this_session"
        ? await this.getSessionFilePath()
        : await this.getProjectFilePath();

    const key = this.resolvePermissionKey(tool, input);

    await this.enqueueWrite(targetPath, async () => {
      const current = await readPermissionFile(targetPath);

      if (
        current.rules.some((rule) => rule.tool === key.tool && rule.fingerprint === key.fingerprint)
      ) {
        return;
      }

      const nextRule: PermissionRule = {
        id: `perm_${randomUUID()}`,
        tool: key.tool,
        fingerprint: key.fingerprint,
        createdAt: new Date().toISOString(),
      };

      const next: PermissionFile = {
        version: 1,
        updatedAt: new Date().toISOString(),
        rules: [...current.rules, nextRule],
      };

      await writePermissionFile(targetPath, next);
    });
  }
}
