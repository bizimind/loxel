import { createResult, runAction } from "@bizimind/cli-common";
import path from "node:path";

import { createEmptyFile, saveFile } from "../file/excalidraw-file.ts";

interface CreateOptions {
  bg?: string;
  force?: boolean;
  json?: boolean;
}

interface CreateResult {
  path: string;
}

export async function createCommand(filePath: string, opts: CreateOptions): Promise<void> {
  await runAction<CreateResult>(opts, async (ctx) => {
    const resolved = path.resolve(filePath);

    if (!opts.force) {
      const exists = await Bun.file(resolved).exists();
      if (exists) {
        throw new Error(`File already exists: ${resolved}. Use --force to overwrite.`);
      }
    }

    const file = createEmptyFile(opts.bg);
    await saveFile(resolved, file);
    ctx.log(`Created ${resolved}`);

    return createResult<CreateResult>({ path: resolved }, (r) => `Created ${r.path}`);
  });
}
