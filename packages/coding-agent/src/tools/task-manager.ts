import { mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { BASH_LIMITS } from "../core/constants.ts";
import { createTaskId } from "../utils/ids.ts";
import { isPathWithin } from "../utils/path.ts";
import { resolveShellBinary } from "../utils/shell.ts";

export type ManagedTaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface ManagedTask {
  id: string;
  type: "bash" | "subagent";
  status: ManagedTaskStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  commandOrPrompt: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  artifactPath: string | null;
  metadata?: Record<string, unknown>;
}

interface RunningTask {
  task: ManagedTask;
  process?: Bun.Subprocess;
  syntheticTimer?: ReturnType<typeof setTimeout>;
}

const managedTaskSchema = z
  .object({
    id: z.string(),
    type: z.enum(["bash", "subagent"]),
    status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
    createdAt: z.string(),
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
    commandOrPrompt: z.string(),
    stdout: z.string(),
    stderr: z.string(),
    exitCode: z.number().int().nullable(),
    artifactPath: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

function nowIso(): string {
  return new Date().toISOString();
}

function truncateOutput(text: string): { preview: string; truncated: boolean } {
  if (text.length <= BASH_LIMITS.maxPreviewBytes) {
    return { preview: text, truncated: false };
  }
  return { preview: text.slice(0, BASH_LIMITS.maxPreviewBytes), truncated: true };
}

export class TaskManager {
  private static readonly runningByDir = new Map<string, Map<string, RunningTask>>();
  private static readonly historyByDir = new Map<string, Map<string, ManagedTask>>();

  constructor(
    private readonly artifactDir: string,
    private readonly spawnEnv?: Record<string, string | undefined>,
  ) {}

  private resolveTaskArtifactPath(taskId: string, suffix: ".json" | ".output.txt"): string | null {
    const baseDir = path.resolve(this.artifactDir);
    const candidate = path.resolve(path.join(baseDir, `${taskId}${suffix}`));
    if (!isPathWithin(baseDir, candidate)) {
      return null;
    }
    return candidate;
  }

  private isArtifactPathAllowed(candidatePath: string): boolean {
    return isPathWithin(path.resolve(this.artifactDir), path.resolve(candidatePath));
  }

  private get running(): Map<string, RunningTask> {
    const existing = TaskManager.runningByDir.get(this.artifactDir);
    if (existing) {
      return existing;
    }
    const created = new Map<string, RunningTask>();
    TaskManager.runningByDir.set(this.artifactDir, created);
    return created;
  }

  private get history(): Map<string, ManagedTask> {
    const existing = TaskManager.historyByDir.get(this.artifactDir);
    if (existing) {
      return existing;
    }
    const created = new Map<string, ManagedTask>();
    TaskManager.historyByDir.set(this.artifactDir, created);
    return created;
  }

  private async ensureArtifactDir(): Promise<void> {
    await mkdir(this.artifactDir, { recursive: true });
  }

  private async persistTask(task: ManagedTask): Promise<void> {
    await this.ensureArtifactDir();
    const filePath = this.resolveTaskArtifactPath(task.id, ".json");
    if (!filePath) {
      throw new Error(`Task id escapes artifact directory: ${task.id}`);
    }
    await Bun.write(filePath, `${JSON.stringify(task, null, 2)}\n`);
  }

  async runBashBackground(command: string, timeoutMs: number, cwd?: string): Promise<ManagedTask> {
    const task: ManagedTask = {
      id: createTaskId(),
      type: "bash",
      status: "running",
      createdAt: nowIso(),
      startedAt: nowIso(),
      finishedAt: null,
      commandOrPrompt: command,
      stdout: "",
      stderr: "",
      exitCode: null,
      artifactPath: null,
    };
    const taskOutputPath = this.resolveTaskArtifactPath(task.id, ".output.txt");
    if (!taskOutputPath) {
      throw new Error(`Task id escapes artifact directory: ${task.id}`);
    }

    const shell = resolveShellBinary();
    const spawned = Bun.spawn([shell, "-c", command], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      cwd: cwd ?? globalThis.process.cwd(),
      env: this.spawnEnv,
    });

    const onTimeout = setTimeout(() => {
      if (this.running.has(task.id)) {
        spawned.kill();
      }
    }, timeoutMs);

    this.running.set(task.id, { task, process: spawned });

    void (async () => {
      try {
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(spawned.stdout).text(),
          new Response(spawned.stderr).text(),
          spawned.exited,
        ]);

        task.stdout = stdout;
        task.stderr = stderr;
        task.exitCode = exitCode;
        task.status = exitCode === 0 ? "completed" : "failed";
      } catch {
        task.status = "failed";
      } finally {
        clearTimeout(onTimeout);
        task.finishedAt = nowIso();
        task.artifactPath = taskOutputPath;
        await this.ensureArtifactDir();
        await Bun.write(taskOutputPath, `${task.stdout}\n${task.stderr}`);
        await this.persistTask(task);
        this.running.delete(task.id);
        this.history.set(task.id, task);
      }
    })();

    await this.persistTask(task);
    this.history.set(task.id, task);
    return task;
  }

  async createSyntheticSubagentTask(
    prompt: string,
    runInBackground: boolean,
    options?: {
      description?: string;
      subagentType?: string;
      model?: string;
      resumedFromTaskId?: string;
    },
  ): Promise<ManagedTask> {
    const task: ManagedTask = {
      id: createTaskId(),
      type: "subagent",
      status: runInBackground ? "running" : "completed",
      createdAt: nowIso(),
      startedAt: nowIso(),
      finishedAt: runInBackground ? null : nowIso(),
      commandOrPrompt: prompt,
      stdout: runInBackground
        ? "Subagent accepted background task. Use TaskOutput to poll status."
        : "Subagent execution completed in local runtime.",
      stderr: "",
      exitCode: runInBackground ? null : 0,
      artifactPath: null,
      metadata: {
        description: options?.description,
        subagent_type: options?.subagentType,
        model: options?.model,
        resumed_from_task_id: options?.resumedFromTaskId ?? null,
      },
    };

    if (runInBackground) {
      const outPath = this.resolveTaskArtifactPath(task.id, ".output.txt");
      if (!outPath) {
        throw new Error(`Task id escapes artifact directory: ${task.id}`);
      }
      task.artifactPath = outPath;
      await this.ensureArtifactDir();
      await Bun.write(outPath, task.stdout);
      const timer = setTimeout(async () => {
        const live = this.running.get(task.id);
        if (!live) {
          return;
        }
        live.task.status = "completed";
        live.task.stdout =
          "Subagent background task completed. Use TaskOutput to retrieve full summary.";
        live.task.exitCode = 0;
        live.task.finishedAt = nowIso();
        if (live.task.artifactPath) {
          await Bun.write(live.task.artifactPath, live.task.stdout);
        }
        await this.persistTask(live.task);
        this.history.set(live.task.id, live.task);
        this.running.delete(live.task.id);
      }, 500);
      this.running.set(task.id, { task, syntheticTimer: timer });
    }

    await this.persistTask(task);
    this.history.set(task.id, task);
    return task;
  }

  private async readTaskFromDisk(taskId: string): Promise<ManagedTask | null> {
    await this.ensureArtifactDir();
    const filePath = this.resolveTaskArtifactPath(taskId, ".json");
    if (!filePath) {
      return null;
    }
    const file = Bun.file(filePath);
    if (!(await file.exists())) {
      return null;
    }
    try {
      const payload = JSON.parse(await file.text()) as unknown;
      const parsed = managedTaskSchema.safeParse(payload);
      if (!parsed.success) {
        return null;
      }
      if (parsed.data.id !== taskId) {
        return null;
      }
      if (parsed.data.artifactPath && !this.isArtifactPathAllowed(parsed.data.artifactPath)) {
        parsed.data.artifactPath = null;
      }
      this.history.set(parsed.data.id, parsed.data);
      return parsed.data;
    } catch {
      return null;
    }
  }

  async resumeSyntheticSubagentTask(
    taskId: string,
    prompt: string,
    runInBackground: boolean,
    options?: { description?: string; subagentType?: string; model?: string },
  ): Promise<ManagedTask | null> {
    const existing = this.history.get(taskId) ?? (await this.readTaskFromDisk(taskId));
    if (!existing || existing.type !== "subagent") {
      return null;
    }

    existing.commandOrPrompt = `${existing.commandOrPrompt}\n\n--- resume ---\n${prompt}`;
    existing.startedAt = existing.startedAt ?? nowIso();

    if (runInBackground) {
      existing.status = "running";
      existing.finishedAt = null;
      existing.stdout = "Subagent resumed in background. Use TaskOutput to monitor.";
      existing.exitCode = null;
      existing.metadata = {
        ...existing.metadata,
        description: options?.description ?? existing.metadata?.description,
        subagent_type: options?.subagentType ?? existing.metadata?.subagent_type,
        model: options?.model ?? existing.metadata?.model,
      };

      if (!existing.artifactPath) {
        const outPath = this.resolveTaskArtifactPath(existing.id, ".output.txt");
        if (!outPath) {
          return null;
        }
        existing.artifactPath = outPath;
      }
      if (!this.isArtifactPathAllowed(existing.artifactPath)) {
        const outPath = this.resolveTaskArtifactPath(existing.id, ".output.txt");
        if (!outPath) {
          return null;
        }
        existing.artifactPath = outPath;
      }
      await Bun.write(existing.artifactPath, existing.stdout);

      const timer = setTimeout(async () => {
        const live = this.running.get(existing.id);
        if (!live) {
          return;
        }
        live.task.status = "completed";
        live.task.stdout = "Subagent resumed task completed.";
        live.task.finishedAt = nowIso();
        live.task.exitCode = 0;
        if (live.task.artifactPath) {
          await Bun.write(live.task.artifactPath, live.task.stdout);
        }
        await this.persistTask(live.task);
        this.history.set(live.task.id, live.task);
        this.running.delete(live.task.id);
      }, 500);
      this.running.set(existing.id, { task: existing, syntheticTimer: timer });
    } else {
      existing.status = "completed";
      existing.finishedAt = nowIso();
      existing.stdout = "Subagent resumed task completed in local runtime.";
      existing.exitCode = 0;
    }

    await this.persistTask(existing);
    this.history.set(existing.id, existing);
    return existing;
  }

  async getOutput(taskId: string, block: boolean, timeoutMs: number): Promise<ManagedTask | null> {
    const running = this.running.get(taskId);
    if (!running) {
      return this.history.get(taskId) ?? (await this.readTaskFromDisk(taskId));
    }

    if (!block) {
      return running.task;
    }

    const started = Date.now();
    while (this.running.has(taskId)) {
      if (Date.now() - started >= timeoutMs) {
        return this.running.get(taskId)?.task ?? null;
      }
      await Bun.sleep(100);
    }

    return this.history.get(taskId) ?? null;
  }

  async stopTask(taskId: string): Promise<boolean> {
    const running = this.running.get(taskId);
    if (!running) {
      const existing = this.history.get(taskId) ?? (await this.readTaskFromDisk(taskId));
      if (!existing) {
        return false;
      }
      if (existing.status === "running") {
        existing.status = "cancelled";
        existing.finishedAt = nowIso();
        await this.persistTask(existing);
      }
      return true;
    }

    running.process?.kill();
    if (running.syntheticTimer) {
      clearTimeout(running.syntheticTimer);
    }
    running.task.status = "cancelled";
    running.task.finishedAt = nowIso();
    this.running.delete(taskId);
    this.history.set(taskId, running.task);
    await this.persistTask(running.task);
    return true;
  }

  preview(task: ManagedTask): {
    stdout: string;
    stderr: string;
    truncated: boolean;
    artifactPath: string | null;
  } {
    const stdoutPreview = truncateOutput(task.stdout);
    const stderrPreview = truncateOutput(task.stderr);
    return {
      stdout: stdoutPreview.preview,
      stderr: stderrPreview.preview,
      truncated: stdoutPreview.truncated || stderrPreview.truncated,
      artifactPath: task.artifactPath,
    };
  }
}
