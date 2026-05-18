import { createResult, runAction } from "@bizimind/cli-common";

import type { OpenResult } from "../types.ts";
import { loadWorktreeContext, selectWorktree } from "../worktree/select.ts";

interface OpenOptions {
  json?: boolean;
  repoPath?: string;
}

/**
 * Open an existing worktree in the configured editor.
 */
export async function openCommand(name?: string, options: OpenOptions = {}): Promise<void> {
  await runAction<OpenResult>(options, async (ctx) => {
    const wtCtx = await loadWorktreeContext({ repoPath: options.repoPath });

    if (!wtCtx.config.editor) {
      // runAction catches thrown errors and converts them to errorResult
      throw new Error('No editor configured. Set "editor" in wt.yaml (e.g., editor: "code").');
    }

    const { worktree, name: selectedName } = await selectWorktree(wtCtx, name, {
      promptMessage: "Select a worktree to open:",
      nonInteractiveUsage: "Usage: wt open <name>",
    });

    ctx.log(`Opening '${selectedName}' in ${wtCtx.config.editor}...`);

    // Run editor in background (don't wait for it)
    Bun.spawn([wtCtx.config.editor, worktree.path], { stdout: "ignore", stderr: "ignore" });

    const result: OpenResult = {
      name: selectedName,
      path: worktree.path,
      editor: wtCtx.config.editor,
    };

    return createResult(result, formatOpenResult);
  });
}

function formatOpenResult(result: OpenResult): string {
  return `Opened '${result.name}' in ${result.editor}`;
}
