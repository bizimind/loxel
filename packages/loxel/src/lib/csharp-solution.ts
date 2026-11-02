import { getCSharpSolutions, setCSharpSolution } from "@/api/csharp-env-client";
import {
  type CSharpBlock,
  type CSharpSolutionsResponse,
  type CSharpStatusResponse,
  csharpToolchain,
} from "@/api/csharp-env-model";
import { showToast } from "@/components/ui/toast";
import { setToolchainStatusData } from "@/queries/use-toolchain-status";
import { type QuickPickItem, requestQuickPick } from "@/store/command-palette";

import { manageRepoTrust } from "./repo-trust-dialog";

// Picker ids that cannot collide with a solution path, which is always absolute.
const AUTOMATIC_ID = "#automatic";
const TRUST_ID = "#trust";
const MAX_TOOLTIP_PROJECTS = 3;

const BLOCK_LABELS: Record<CSharpBlock, string> = {
  untrusted: "C#: Not trusted",
  "no-dotnet": "C#: .NET missing",
  "no-csharp-ls": "C#: csharp-ls missing",
  "old-csharp-ls": "C#: csharp-ls too old",
  "csharp-ls-failed": "C#: csharp-ls failed",
  "not-restored": "C#: Not restored",
  "load-failed": "C#: Load failed",
};

function baseName(file: string): string {
  return file.slice(file.lastIndexOf("/") + 1);
}

function displayPath(file: string, wtPath: string): string {
  const root = wtPath.endsWith("/") ? wtPath : `${wtPath}/`;
  return file.startsWith(root) ? file.slice(root.length) : file;
}

/** A few projects and how many more: the browser cuts a long tooltip off at its end. */
function loadedProjects(projects: readonly string[], wtPath: string): string {
  const shown = projects.slice(0, MAX_TOOLTIP_PROJECTS).map((file) => displayPath(file, wtPath));
  const more = projects.length - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
}

/** The status bar's words; null when there is nothing to show. */
export function csharpStatusLabel({ server }: CSharpStatusResponse): string | null {
  if (!server || server.kind === "no-project") return null;
  if (server.kind === "stopped") return "C#";
  if (server.kind === "blocked") return BLOCK_LABELS[server.block];
  if (server.target) return `C#: ${baseName(server.target)}`;
  const [only] = server.projects;
  return server.projects.length === 1 && only
    ? `C#: ${baseName(only)}`
    : `C#: ${server.projects.length} projects`;
}

/** Something needs doing: a step is missing, or the chosen solution is not what loads. */
export function csharpStatusWarning({ server, chosenMissing }: CSharpStatusResponse): boolean {
  return server?.kind === "blocked" || chosenMissing;
}

/** The status bar's detail on hover. */
export function csharpStatusTooltip(status: CSharpStatusResponse, wtPath: string): string {
  const { server, chosen, chosenMissing } = status;
  const lines: string[] = [];
  if (server?.kind === "blocked") lines.push(server.message);
  if (server?.kind === "stopped") lines.push("csharp-ls is not running");
  if (server?.kind === "running") {
    lines.push(
      server.target
        ? `Loaded: ${displayPath(server.target, wtPath)}`
        : `Loaded: ${loadedProjects(server.projects, wtPath)}`,
      `.NET SDK ${server.sdkVersion}`,
      chosen && !chosenMissing ? "Chosen for this worktree" : "Detected automatically",
    );
  }
  if (chosen && chosenMissing) {
    lines.push(
      `The chosen solution ${displayPath(chosen, wtPath)} is gone, so detection picks what loads`,
    );
  }
  lines.push("Click to select a solution");
  return lines.join("\n");
}

function solutionItems(state: CSharpSolutionsResponse, wtPath: string): QuickPickItem[] {
  const { solutions, automatic, chosen, trusted } = state;
  const usable = chosen !== null && solutions.includes(chosen);
  return [
    ...(trusted
      ? []
      : [
          {
            id: TRUST_ID,
            label: "This repository is not trusted, so nothing loads",
            description: "Manage trust…",
          },
        ]),
    {
      id: AUTOMATIC_ID,
      label: "Use automatic detection",
      description: automatic ? displayPath(automatic, wtPath) : "Every project",
      current: !usable,
    },
    ...solutions.map((solution) => ({
      id: solution,
      label: baseName(solution),
      description: displayPath(solution, wtPath),
      current: solution === chosen,
    })),
  ];
}

/**
 * Let the user choose what csharp-ls loads for worktree `wtPath`, in the command palette. The choice
 * is saved per worktree on the server, which restarts csharp-ls with it. It widens nothing: an
 * untrusted repository still loads nothing, and the first item says so.
 */
export async function selectCSharpSolution(wtPath: string): Promise<void> {
  const items = getCSharpSolutions(wtPath).then((state) => solutionItems(state, wtPath));
  const picked = await requestQuickPick({ placeholder: "Select a C# solution", items });
  if (picked === null) return;
  if (picked === TRUST_ID) {
    await manageRepoTrust(wtPath);
    return;
  }
  try {
    const solutionPath = picked === AUTOMATIC_ID ? null : picked;
    const response = await setCSharpSolution({ worktreePath: wtPath, solutionPath });
    setToolchainStatusData(csharpToolchain, wtPath, response);
  } catch (err) {
    showToast(err instanceof Error ? err.message : "Could not set the C# solution");
  }
}
