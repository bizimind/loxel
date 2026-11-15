import { realpath } from "node:fs/promises";
import path from "node:path";

import {
  type CSharpLspState,
  type CSharpSolutionsResponse,
  type CSharpStatusResponse,
  csharpToolchain,
} from "@/api/csharp-env-model";

import {
  automaticCSharpSolution,
  csharpSelectableSolutions,
  discoverCSharpProjects,
} from "./csharp-env";
import { announceCSharpStatus, getCSharpLspState, subscribeCSharpStatus } from "./csharp-lsp-state";
import {
  csharpSolutionStoreKey,
  getCSharpSolution,
  onCSharpSolutionChange,
  setCSharpSolution,
} from "./csharp-solution-store";
import { isInside } from "./path-containment";
import { isRepoTrusted } from "./repo-trust";
import { error, json } from "./response-helpers";
import type { ToolchainStatusModule } from "./toolchain-status-module";

/**
 * The manager's state and the choice. It decides nothing about an untrusted repository beyond that,
 * so whether it has a project at all, which shows nothing, is read here: git listing files, as for
 * any `dotnet` check there.
 */
async function csharpStatus(wtPath: string): Promise<CSharpStatusResponse> {
  const chosen = getCSharpSolution(wtPath);
  const isUntrusted = (state: CSharpLspState | null) =>
    state?.kind === "blocked" && state.block === "untrusted";
  if (!chosen && !isUntrusted(getCSharpLspState(wtPath))) {
    return { server: getCSharpLspState(wtPath), chosen, chosenMissing: false };
  }
  const discovered = await discoverCSharpProjects(wtPath);
  // Read after the wait, so that this does not answer with what a newer decision replaced.
  const server = getCSharpLspState(wtPath);
  return {
    server:
      isUntrusted(server) && discovered.projects.length === 0 ? { kind: "no-project" } : server,
    chosen,
    chosenMissing: chosen !== null && !csharpSelectableSolutions(discovered).includes(chosen),
  };
}

// GET /api/csharp-status?wt= — What the C# language server is doing for a worktree
async function handleCSharpStatus(wtPath: string): Promise<Response> {
  return json(await csharpStatus(wtPath));
}

// GET /api/csharp-status/solutions?wt= — What the user can choose for a worktree
async function handleCSharpSolutions(wtPath: string): Promise<Response> {
  const discovered = await discoverCSharpProjects(wtPath);
  const response: CSharpSolutionsResponse = {
    solutions: csharpSelectableSolutions(discovered),
    automatic: automaticCSharpSolution(discovered),
    chosen: getCSharpSolution(wtPath),
    trusted: isRepoTrusted(wtPath),
  };
  return json(response);
}

/** Only what discovery lists, and only if it really lies in the worktree: a symlink may not. */
async function normalizeSolution(wtPath: string, solutionPath: string): Promise<string> {
  const absolute = path.resolve(wtPath, solutionPath);
  const selectable = csharpSelectableSolutions(await discoverCSharpProjects(wtPath));
  if (!selectable.includes(absolute)) {
    throw new Error(`${solutionPath} is not a solution in this worktree`);
  }
  const [real, realWtPath] = await Promise.all([realpath(absolute), realpath(wtPath)]);
  if (!isInside(real, realWtPath)) throw new Error(`${solutionPath} is outside this worktree`);
  return absolute;
}

// POST /api/csharp-status/solution — Choose a worktree's solution, or (null) return to detection
async function handleCSharpSolution(
  wtPath: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const { solutionPath } = body;
  if (solutionPath !== null && typeof solutionPath !== "string") {
    return error("solutionPath must be a string or null", 400);
  }
  try {
    const chosen = solutionPath === null ? null : await normalizeSolution(wtPath, solutionPath);
    setCSharpSolution(wtPath, chosen);
  } catch (err) {
    return error(err instanceof Error ? err.message : "Invalid C# solution", 400);
  }
  return json(await csharpStatus(wtPath));
}

export const csharpToolchainStatus: ToolchainStatusModule = {
  toolchain: csharpToolchain,
  subscribe: (wtPath, listener) => subscribeCSharpStatus(wtPath, () => listener({ changed: true })),
  refresh: announceCSharpStatus,
  // The manager follows the login shell's environment itself, for what it holds.
  refreshAll: () => {},
  onOverrideChange: onCSharpSolutionChange,
  overrideStoreKey: csharpSolutionStoreKey,
  routes: {
    GET: {
      "/api/csharp-status": handleCSharpStatus,
      "/api/csharp-status/solutions": handleCSharpSolutions,
    },
    POST: { "/api/csharp-status/solution": handleCSharpSolution },
  },
};
