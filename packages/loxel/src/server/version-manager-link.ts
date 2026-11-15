import { realpath } from "node:fs/promises";
import path from "node:path";

const VERSION_MANAGERS = new Set(["mise", "rtx", "volta-shim"]);

/** Whether a tool is a link to mise or Volta, without judging one that is a script. */
export async function linksToVersionManager(filePath: string): Promise<boolean> {
  const real = await realpath(filePath).catch(() => filePath);
  return VERSION_MANAGERS.has(path.basename(real));
}
