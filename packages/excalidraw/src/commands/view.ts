import path from "node:path";

import { createResult, runAction } from "@bizimind/cli-common";

import { loadFile } from "../file/excalidraw-file.ts";

interface ViewOptions {
  output?: string;
  scale?: number;
  padding?: number;
  json?: boolean;
  filterIds?: string[];
}

interface ViewResult {
  path: string;
}

export async function viewCommand(filePath: string, opts: ViewOptions): Promise<void> {
  await runAction<ViewResult>(opts, async (ctx) => {
    const resolved = path.resolve(filePath);
    const file = await loadFile(resolved);

    let outputPath: string;
    if (opts.output) {
      outputPath = path.resolve(opts.output);
    } else if (resolved.endsWith(".excalidraw")) {
      outputPath = resolved.replace(/\.excalidraw$/, ".png");
    } else {
      outputPath = resolved + ".png";
    }

    ctx.log("Rendering diagram...");

    const { renderToPng } = await import("../render/render-png.ts");
    const pngBuffer = await renderToPng(file, {
      scale: opts.scale ?? 2,
      padding: opts.padding ?? 20,
      filterIds: opts.filterIds,
    });

    await Bun.write(outputPath, pngBuffer);
    ctx.log(`Rendered to ${outputPath}`);

    return createResult<ViewResult>({ path: outputPath }, (r) => `Rendered to ${r.path}`);
  });
}
