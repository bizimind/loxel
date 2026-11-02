import { existsSync } from "node:fs";
import path from "node:path";

import {
  type JavaBuildFileResponse,
  type JavaEnvCandidatesResponse,
  type JavaEnvResponse,
  javaToolchain,
} from "@/api/java-env-model";

import {
  getJavaEnvResolution,
  type JavaEnvUpdate,
  listJavaRuntimes,
  normalizeJavaOverride,
  refreshAllJavaEnvs,
  refreshJavaEnv,
  resolveJavaEnv,
  subscribeJavaEnv,
} from "./java-env";
import { canRunJdtls, jdtlsHostCrossed } from "./java-lsp-manager";
import {
  getJavaOverride,
  javaOverrideStoreKey,
  onJavaOverrideChange,
  setJavaOverride,
} from "./java-override-store";
import { error, json } from "./response-helpers";
import { isInside } from "./shipped-by-repo";
import type { ToolchainStatusModule } from "./toolchain-status-module";

async function javaEnvResponse(wtPath: string): Promise<JavaEnvResponse> {
  const { env, ignoredJavaHome } = await getJavaEnvResolution(wtPath);
  return { env, overridePath: getJavaOverride(wtPath), ignoredJavaHome };
}

// GET /api/java-env?wt= — The JDK Loxel uses for a worktree
async function handleJavaEnv(wtPath: string): Promise<Response> {
  return json(await javaEnvResponse(wtPath));
}

// GET /api/java-env/candidates?wt= — JDKs the user can choose for a worktree
async function handleJavaEnvCandidates(wtPath: string): Promise<Response> {
  const [candidates, automatic] = await Promise.all([
    listJavaRuntimes(wtPath),
    resolveJavaEnv(wtPath, { overridePath: null }),
  ]);
  const response: JavaEnvCandidatesResponse = {
    candidates,
    automatic: automatic.env,
    overridePath: getJavaOverride(wtPath),
  };
  return json(response);
}

// POST /api/java-env/override — Choose a worktree's JDK, or (null) return to detection
async function handleJavaOverride(
  wtPath: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const { javaHome } = body;
  if (javaHome !== null && typeof javaHome !== "string") {
    return error("javaHome must be a string or null", 400);
  }
  let chosen: string | null = null;
  if (javaHome !== null) {
    try {
      chosen = await normalizeJavaOverride(wtPath, javaHome);
    } catch (err) {
      return error(err instanceof Error ? err.message : "Invalid JDK", 400);
    }
  }
  setJavaOverride(wtPath, chosen);
  return json(await javaEnvResponse(wtPath));
}

const BUILD_FILES = [
  ["pom.xml", "Maven"],
  ["build.gradle", "Gradle"],
  ["build.gradle.kts", "Gradle"],
  ["settings.gradle", "Gradle"],
  ["settings.gradle.kts", "Gradle"],
] as const;

/** The tool of the nearest build file from `filePath`'s folder up to the worktree; nothing is run. */
export function nearestBuildTool(
  wtPath: string,
  filePath: string,
): JavaBuildFileResponse["buildTool"] {
  let dir = path.dirname(filePath);
  while (isInside(dir, wtPath)) {
    for (const [name, tool] of BUILD_FILES) {
      if (existsSync(path.join(dir, name))) return tool;
    }
    if (dir === wtPath) break;
    dir = path.dirname(dir);
  }
  return null;
}

// POST /api/java-env/build-file — The build tool of the project a Java file belongs to
async function handleJavaBuildFile(
  wtPath: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const { filePath } = body;
  if (typeof filePath !== "string") return error("filePath must be a string", 400);
  const response: JavaBuildFileResponse = { buildTool: nearestBuildTool(wtPath, filePath) };
  return json(response);
}

/**
 * Like {@link subscribeJavaEnv}, and also reports a change when a JDK that can run the language
 * server appears or goes, though the worktree's own JDK stays: a client whose server could not start
 * for lack of one tries again on that message.
 */
function subscribeJavaStatus(
  wtPath: string,
  listener: (update: JavaEnvUpdate) => void,
): () => void {
  let couldRun: boolean | null = null;
  return subscribeJavaEnv(wtPath, (update) => {
    void listJavaRuntimes(wtPath).then((runtimes) => {
      const canRun = canRunJdtls(runtimes);
      const crossed = jdtlsHostCrossed(couldRun, canRun);
      couldRun = canRun;
      listener({ ...update, changed: update.changed || crossed });
    });
  });
}

export const javaToolchainStatus: ToolchainStatusModule = {
  toolchain: javaToolchain,
  subscribe: subscribeJavaStatus,
  refresh: refreshJavaEnv,
  refreshAll: refreshAllJavaEnvs,
  onOverrideChange: onJavaOverrideChange,
  overrideStoreKey: javaOverrideStoreKey,
  routes: {
    GET: { "/api/java-env": handleJavaEnv, "/api/java-env/candidates": handleJavaEnvCandidates },
    POST: {
      "/api/java-env/build-file": handleJavaBuildFile,
      "/api/java-env/override": handleJavaOverride,
    },
  },
};
