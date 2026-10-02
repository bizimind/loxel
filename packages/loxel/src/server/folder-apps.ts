/**
 * Apps offered in "Open In" for folders.
 *
 * LaunchServices is no help for directories: it offers Finder, media players and archivers,
 * not terminals or editors. Instead, Loxel offers a curated list of developer apps that open
 * a folder as a window or project (via `open -a <app> <folder>`), filtered to the ones
 * installed in the standard application folders. Plain file-system checks, no helper needed.
 */
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { OpenInApp, OpenInAppGroup } from "@/api/open-in-model";

/** Bundle names (without `.app`), in menu order within each group. */
const FOLDER_APPS: { group: OpenInAppGroup; names: string[] }[] = [
  { group: "terminal", names: ["Terminal", "iTerm", "Ghostty", "Warp"] },
  {
    group: "editor",
    names: [
      "Visual Studio Code",
      "Cursor",
      "Windsurf",
      "Zed",
      "Sublime Text",
      "IntelliJ IDEA",
      "IntelliJ IDEA Ultimate",
      "IntelliJ IDEA CE",
      "WebStorm",
      "PyCharm",
      "PyCharm Professional Edition",
      "PyCharm CE",
      "GoLand",
      "RustRover",
      "CLion",
      "PhpStorm",
      "RubyMine",
      "Rider",
      "Android Studio",
    ],
  },
];

/** Where apps are installed: system-wide, per-user (e.g. JetBrains Toolbox), and Terminal's home. */
export function defaultFolderAppDirs(): string[] {
  return ["/Applications", join(homedir(), "Applications"), "/System/Applications/Utilities"];
}

async function isDirectory(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => null);
  return info?.isDirectory() ?? false;
}

async function findApp(name: string, searchDirs: string[]): Promise<string | null> {
  for (const dir of searchDirs) {
    const path = join(dir, `${name}.app`);
    if (await isDirectory(path)) return path;
  }
  return null;
}

/** Installed folder apps, terminals first, then editors. */
export async function listFolderApps(
  searchDirs: string[] = defaultFolderAppDirs(),
): Promise<OpenInApp[]> {
  const candidates = FOLDER_APPS.flatMap(({ group, names }) =>
    names.map((name) => ({ group, name })),
  );
  const paths = await Promise.all(candidates.map(({ name }) => findApp(name, searchDirs)));
  return candidates.flatMap(({ group, name }, i) => {
    const path = paths[i];
    return path ? [{ path, name, group }] : [];
  });
}
