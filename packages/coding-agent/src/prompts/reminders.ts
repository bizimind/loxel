import { REMINDER_DEFAULTS } from "../core/constants.ts";
import type { SessionRecord } from "../session/model.ts";

function defaultsForKey(key: string): { cooldown: number; maxRepeats: number } {
  switch (key) {
    case "background_task_active":
      return {
        cooldown: REMINDER_DEFAULTS.backgroundTaskTurns,
        maxRepeats: Number.MAX_SAFE_INTEGER,
      };
    case "context_compacted":
      return {
        cooldown: REMINDER_DEFAULTS.contextCompactedTurns,
        maxRepeats: Number.MAX_SAFE_INTEGER,
      };
    case "permission_denied":
      return { cooldown: REMINDER_DEFAULTS.permissionDeniedTurns, maxRepeats: 1 };
    case "plan_mode_exited":
      return { cooldown: REMINDER_DEFAULTS.planExitedTurns, maxRepeats: 1 };
    default:
      return { cooldown: 1, maxRepeats: Number.MAX_SAFE_INTEGER };
  }
}

export function activateReminder(
  session: SessionRecord,
  key: string,
  payload?: Record<string, string>,
): void {
  const defaults = defaultsForKey(key);
  session.state.reminders.activeConditions[key] = true;
  session.state.reminders.conditionPayload[key] = payload ?? {};
  if (!(key in session.state.reminders.cooldowns)) {
    session.state.reminders.cooldowns[key] = defaults.cooldown;
  }
  if (!(key in session.state.reminders.maxRepeats)) {
    session.state.reminders.maxRepeats[key] = defaults.maxRepeats;
  }
}

export function clearReminder(session: SessionRecord, key: string): void {
  session.state.reminders.activeConditions[key] = false;
  delete session.state.reminders.conditionPayload[key];
  delete session.state.reminders.repeats[key];
  delete session.state.reminders.reminderHistory[key];
}

export function markReminderInjected(session: SessionRecord, key: string): void {
  const turnIndex = Object.keys(session.messages).length;
  session.state.reminders.reminderHistory[key] = turnIndex;
  session.state.reminders.repeats[key] = (session.state.reminders.repeats[key] ?? 0) + 1;
}
