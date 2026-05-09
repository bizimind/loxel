import { mkdir } from "node:fs/promises";
import path from "node:path";

import { STATE_ROOT } from "../core/constants.ts";
import { assertValidSessionId } from "../core/id-format.ts";
import { expandHome } from "../utils/path.ts";

export interface StateLayout {
  root: string;
  settingsFile: string;
  permissionsProjectDir: string;
  permissionsSessionDir: string;
  sessionsDir: string;
  plansDir: string;
}

export function getStateLayout(): StateLayout {
  const root = process.env.CODING_AGENT_STATE_ROOT
    ? expandHome(process.env.CODING_AGENT_STATE_ROOT)
    : expandHome(STATE_ROOT);
  return {
    root,
    settingsFile: path.join(root, "settings.json"),
    permissionsProjectDir: path.join(root, "permissions", "project"),
    permissionsSessionDir: path.join(root, "permissions", "session"),
    sessionsDir: path.join(root, "sessions"),
    plansDir: path.join(root, "plans"),
  };
}

export function getSessionPaths(sessionId: string): {
  root: string;
  eventsFile: string;
  branchesDir: string;
  snapshotsDir: string;
  artifactsDir: string;
  compactionsDir: string;
  toolOutputDir: string;
  tasksDir: string;
} {
  assertValidSessionId(sessionId);
  const layout = getStateLayout();
  const root = path.join(layout.sessionsDir, sessionId);
  const artifactsDir = path.join(root, "artifacts");

  return {
    root,
    eventsFile: path.join(root, "events.jsonl"),
    branchesDir: path.join(root, "branches"),
    snapshotsDir: path.join(root, "snapshots"),
    artifactsDir,
    compactionsDir: path.join(artifactsDir, "compactions"),
    toolOutputDir: path.join(artifactsDir, "tool-output"),
    tasksDir: path.join(artifactsDir, "tasks"),
  };
}

export async function ensureStateLayout(): Promise<StateLayout> {
  const layout = getStateLayout();

  await mkdir(layout.root, { recursive: true });
  await mkdir(layout.permissionsProjectDir, { recursive: true });
  await mkdir(layout.permissionsSessionDir, { recursive: true });
  await mkdir(layout.sessionsDir, { recursive: true });
  await mkdir(layout.plansDir, { recursive: true });

  return layout;
}

export async function ensureSessionLayout(
  sessionId: string,
): Promise<ReturnType<typeof getSessionPaths>> {
  const paths = getSessionPaths(sessionId);
  await mkdir(paths.root, { recursive: true });
  await mkdir(paths.branchesDir, { recursive: true });
  await mkdir(paths.snapshotsDir, { recursive: true });
  await mkdir(paths.artifactsDir, { recursive: true });
  await mkdir(paths.compactionsDir, { recursive: true });
  await mkdir(paths.toolOutputDir, { recursive: true });
  await mkdir(paths.tasksDir, { recursive: true });
  return paths;
}
