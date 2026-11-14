/**
 * What a new Claude Code session will start with, read before its process answers, so the panel
 * shows real values from its first frame: the model, effort and permission mode from the user's,
 * the project's and the local settings files and the env overrides, and the model catalog the
 * last session reported. The session's own `get_settings` replaces these moments later.
 */
import { join } from "node:path";

import { type AgentEvent, isAgentPermissionMode } from "@/api/agent-session-model";
import { isRecord } from "@/lib/is-record";

/** The settings fields the composer shows; later sources win, as in Claude Code. */
export interface ClaudeStartingSettings {
  model?: string;
  effort?: string;
  permissionMode?: string;
  /** `modelSettings.<model>.effortLevel`, which beats the top-level effort for that model. */
  effortByModel?: Record<string, string>;
}

async function readSettingsFile(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await Bun.file(path).text());
    return isRecord(parsed) ? parsed : {};
  } catch {
    // Missing or not JSON: Claude Code ignores it too.
    return {};
  }
}

/** Merges the settings files in precedence order, then the env overrides. */
export function mergeStartingSettings(
  files: readonly Record<string, unknown>[],
  env: Record<string, string | undefined>,
): ClaudeStartingSettings {
  const merged: ClaudeStartingSettings = {};
  for (const file of files) {
    if (typeof file.model === "string") merged.model = file.model;
    if (typeof file.effortLevel === "string") merged.effort = file.effortLevel;
    const permissions = isRecord(file.permissions) ? file.permissions : null;
    if (typeof permissions?.defaultMode === "string") {
      merged.permissionMode = permissions.defaultMode;
    }
    if (isRecord(file.modelSettings)) {
      for (const [model, value] of Object.entries(file.modelSettings)) {
        if (isRecord(value) && typeof value.effortLevel === "string") {
          merged.effortByModel = { ...merged.effortByModel, [model]: value.effortLevel };
        }
      }
    }
  }
  if (env.ANTHROPIC_MODEL) merged.model = env.ANTHROPIC_MODEL;
  const effort = env.CLAUDE_CODE_EFFORT_LEVEL;
  if (effort && effort !== "unset") {
    merged.effort = effort;
    // The env sets the level for every model.
    delete merged.effortByModel;
  }
  return merged;
}

/** User, project and local settings of a worktree, merged with the env. */
export async function readStartingSettings(
  configDir: string,
  worktreePath: string,
  env: Record<string, string | undefined>,
): Promise<ClaudeStartingSettings> {
  const files = await Promise.all([
    readSettingsFile(join(configDir, "settings.json")),
    readSettingsFile(join(worktreePath, ".claude", "settings.json")),
    readSettingsFile(join(worktreePath, ".claude", "settings.local.json")),
  ]);
  return mergeStartingSettings(files, env);
}

/**
 * The events that set a new session's starting values: the last known catalog, the model (the
 * catalog's default when the settings name none), the effort, and the permission mode ("default"
 * when unset, which is a real mode: ask before edits).
 */
export function startingEvents(
  settings: ClaudeStartingSettings,
  catalog: Extract<AgentEvent, { type: "catalog" }> | null,
): AgentEvent[] {
  const events: AgentEvent[] = catalog ? [catalog] : [];
  const models = catalog?.models ?? [];
  const defaultModel = models.find((m) => m.value === "default")?.resolvedModel ?? undefined;
  const model = settings.model ?? defaultModel;
  if (model) events.push({ type: "model", model });
  // Per-model effort is keyed by the model's id, which an alias such as "opus" stands for.
  const resolved = models.find((m) => m.value === model)?.resolvedModel ?? model;
  const effort =
    (model && settings.effortByModel?.[model]) ??
    (resolved && settings.effortByModel?.[resolved]) ??
    settings.effort;
  if (effort) events.push({ type: "effort", effort });
  events.push({
    type: "permission_mode",
    mode: isAgentPermissionMode(settings.permissionMode) ? settings.permissionMode : "default",
  });
  return events;
}
