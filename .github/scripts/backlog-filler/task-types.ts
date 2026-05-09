export const TASK_TYPES = [
  { type: "idea", weight: 25, desc: "A creative concept to explore" },
  { type: "feature", weight: 20, desc: "A new capability to implement" },
  { type: "optimization", weight: 12, desc: "Performance or efficiency improvement" },
  { type: "test", weight: 10, desc: "Test coverage or quality improvement" },
  { type: "refactor", weight: 10, desc: "Code restructuring without behavior change" },
  { type: "chore", weight: 8, desc: "Maintenance or housekeeping task" },
  { type: "docs", weight: 8, desc: "Documentation improvement" },
  { type: "epic", weight: 7, desc: "Large initiative spanning multiple tasks" },
] as const;

export type TaskType = (typeof TASK_TYPES)[number];

export function selectRandomTaskType(): TaskType {
  const totalWeight = TASK_TYPES.reduce((sum, t) => sum + t.weight, 0);
  let random = Math.random() * totalWeight;

  for (const task of TASK_TYPES) {
    random -= task.weight;
    if (random <= 0) return task;
  }

  return TASK_TYPES[0];
}
