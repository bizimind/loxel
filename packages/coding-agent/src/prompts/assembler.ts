import { createHash } from "node:crypto";

import type { SessionRecord } from "../session/model.ts";
import type { CanonicalToolName } from "../tools/tool-names.ts";

import { REMINDER_DEFAULTS } from "../core/constants.ts";
import { buildCapabilityFallbackHints, normalizeDeclaredTools } from "../tools/capabilities.ts";
import { baseSystemPrompt, planModePrompt, toolReminderTemplate } from "./templates.ts";
import { validatePromptRender } from "./validator.ts";

export interface PromptSegment {
  id: string;
  layer: string;
  priority: number;
  content: string;
}

export interface PromptAssemblyMetadata {
  segmentIds: string[];
  droppedSegmentIds: string[];
  approxTokenCount: number;
  cacheKey: string;
}

export interface PromptAssemblyResult {
  systemSegments: PromptSegment[];
  developerSegments: PromptSegment[];
  ephemeralReminderSegments: PromptSegment[];
  metadata: PromptAssemblyMetadata;
}

export interface PromptAssemblyInput {
  session: SessionRecord;
  dateIso: string;
  activeToolReminders: CanonicalToolName[];
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function makeSegment(id: string, layer: string, priority: number, content: string): PromptSegment {
  return { id, layer, priority, content };
}

function buildCacheKey(segments: PromptSegment[]): string {
  const digest = createHash("sha256");
  for (const segment of segments) {
    digest.update(segment.id);
    digest.update("\n");
    digest.update(segment.content);
    digest.update("\n");
  }
  return digest.digest("hex");
}

function shouldInjectReminder(session: SessionRecord, key: string, turnIndex: number): boolean {
  const active = session.state.reminders.activeConditions[key] ?? false;
  if (!active) {
    return false;
  }

  const lastTurn = session.state.reminders.reminderHistory[key] ?? -1;
  const fallbackCooldown =
    key === "background_task_active"
      ? REMINDER_DEFAULTS.backgroundTaskTurns
      : key === "context_compacted"
        ? REMINDER_DEFAULTS.contextCompactedTurns
        : key === "permission_denied"
          ? REMINDER_DEFAULTS.permissionDeniedTurns
          : key === "plan_mode_exited"
            ? REMINDER_DEFAULTS.planExitedTurns
            : 1;
  const cooldown = session.state.reminders.cooldowns[key] ?? fallbackCooldown;
  const repeats = session.state.reminders.repeats[key] ?? 0;
  const maxRepeats = session.state.reminders.maxRepeats[key] ?? Number.MAX_SAFE_INTEGER;

  if (repeats >= maxRepeats) {
    return false;
  }

  return turnIndex - lastTurn >= cooldown;
}

export function buildPromptAssembly(input: PromptAssemblyInput): PromptAssemblyResult {
  const systemSegments: PromptSegment[] = [];
  const developerSegments: PromptSegment[] = [];
  const reminderSegments: PromptSegment[] = [];

  const base = baseSystemPrompt.render({ date: input.dateIso });
  const baseValidation = validatePromptRender(baseSystemPrompt, base);
  if (!baseValidation.ok) {
    throw new Error(
      `Prompt validation failed for ${baseSystemPrompt.name}: ${baseValidation.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  systemSegments.push(makeSegment("base.system", "base", 100, base));

  if (input.session.state.mode === "plan") {
    const plan = planModePrompt.render({
      planFilePath: input.session.state.plan.planFilePath ?? "<missing-plan-file>",
    });
    const planValidation = validatePromptRender(planModePrompt, plan);
    if (!planValidation.ok) {
      throw new Error(
        `Prompt validation failed for ${planModePrompt.name}: ${planValidation.issues.map((issue) => issue.message).join("; ")}`,
      );
    }
    developerSegments.push(makeSegment("mode.plan", "mode", 90, plan));
  }

  const declared = normalizeDeclaredTools(input.session.declaredTools);
  const capabilityHints = buildCapabilityFallbackHints(declared);
  for (const [index, hint] of capabilityHints.entries()) {
    reminderSegments.push(makeSegment(`reminder.capability_${index + 1}`, "reminder", 40, hint));
  }

  for (const toolName of input.activeToolReminders) {
    const toolSegment = toolReminderTemplate(toolName).render({});
    reminderSegments.push(makeSegment(`tool.${toolName}`, "tool", 50, toolSegment));
  }

  const turnIndex = Object.keys(input.session.messages).length;

  if (shouldInjectReminder(input.session, "background_task_active", turnIndex)) {
    reminderSegments.push(
      makeSegment(
        "reminder.background_task_active",
        "reminder",
        60,
        "A background task is active. Use TaskOutput to fetch progress and TaskStop to stop it.",
      ),
    );
  }

  if (shouldInjectReminder(input.session, "context_compacted", turnIndex)) {
    reminderSegments.push(
      makeSegment(
        "reminder.context_compacted",
        "reminder",
        55,
        "Context was compacted. Verify assumptions against source files before making edits.",
      ),
    );
  }

  if (shouldInjectReminder(input.session, "permission_denied", turnIndex)) {
    reminderSegments.push(
      makeSegment(
        "reminder.permission_denied",
        "reminder",
        75,
        "Approval was denied. Do not repeat the same call. Propose a safer alternative or ask the user for a different approach.",
      ),
    );
  }

  if (shouldInjectReminder(input.session, "plan_mode_exited", turnIndex)) {
    const approvedPlan = input.session.state.plan.planFilePath ?? "<missing-plan-file>";
    reminderSegments.push(
      makeSegment(
        "reminder.plan_mode_exited",
        "reminder",
        80,
        `Plan approved and plan mode exited. Execute against plan file ${approvedPlan} and track progress via TodoWrite/TodoRead.`,
      ),
    );
  }

  if (input.session.state.mode === "plan") {
    reminderSegments.push(
      makeSegment(
        "reminder.plan_mode_active",
        "reminder",
        95,
        "Plan mode active: do not execute implementation steps. Maintain the plan file and request ExitPlanMode when ready.",
      ),
    );
  }

  const allSegments = [...systemSegments, ...developerSegments, ...reminderSegments].sort(
    (a, b) => b.priority - a.priority,
  );

  const tokenBudget = 2_200;
  let used = 0;
  const kept = new Set<string>();
  const dropped: string[] = [];

  for (const segment of allSegments) {
    const tokens = estimateTokens(segment.content);
    if (used + tokens > tokenBudget && segment.layer === "reminder") {
      dropped.push(segment.id);
      continue;
    }
    kept.add(segment.id);
    used += tokens;
  }

  const keptSystem = systemSegments.filter((segment) => kept.has(segment.id));
  const keptDeveloper = developerSegments.filter((segment) => kept.has(segment.id));
  const keptReminders = reminderSegments.filter((segment) => kept.has(segment.id));

  return {
    systemSegments: keptSystem,
    developerSegments: keptDeveloper,
    ephemeralReminderSegments: keptReminders,
    metadata: {
      segmentIds: [...kept],
      droppedSegmentIds: dropped,
      approxTokenCount: used,
      cacheKey: buildCacheKey([...keptSystem, ...keptDeveloper, ...keptReminders]),
    },
  };
}
