import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { StatusInfo } from "@/api/git-models";

import { ProjectFilesService } from "./project-files-service";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

async function seedRepo(): Promise<string> {
  const base = mkdtempSync(path.join(tmpdir(), "pfs-"));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, "repo");
  await Bun.$`git init -q -b main ${repo}`.quiet();
  await Bun.write(path.join(repo, "a.txt"), "a\n");
  await Bun.$`git -C ${repo} add -A`.quiet();
  await Bun.$`git -C ${repo} -c user.email=t@t -c user.name=t commit -q -m init`.quiet();
  return repo;
}

describe("ProjectFilesService status notifications", () => {
  test("a working-tree edit reports a status change", async () => {
    const repo = await seedRepo();
    let fired = false;
    let resolveFired: () => void = () => {};
    const firedOnce = new Promise<"notified">((resolve) => {
      resolveFired = () => {
        fired = true;
        resolve("notified");
      };
    });
    const service = new ProjectFilesService(repo, () => {}, undefined, resolveFired);
    cleanups.push(() => service.stop());
    await service.start();
    // start() builds the maps but is not an edit; nothing should have fired yet.
    expect(fired).toBe(false);
    await Bun.sleep(300);

    await Bun.write(path.join(repo, "a.txt"), "changed\n");

    const timeout = Bun.sleep(8000).then(() => "timeout" as const);
    expect(await Promise.race([firedOnce, timeout])).toBe("notified");
  }, 20000);

  test("a git-dir driven refresh reports the fresh status exactly once", async () => {
    const repo = await seedRepo();
    const reported: StatusInfo[] = [];
    const service = new ProjectFilesService(
      repo,
      () => {},
      undefined,
      (status) => {
        reported.push(status);
      },
    );
    cleanups.push(() => service.stop());
    // Written before start() so the working-tree watcher has nothing to report.
    await Bun.write(path.join(repo, "new.txt"), "n\n");
    await service.start();
    await Bun.sleep(300);

    await service.refreshGitStatus();

    // The callback publishes the snapshot; it must not feed another refresh.
    await Bun.sleep(200);
    expect(reported).toHaveLength(1);
    expect(reported[0]!.untracked).toEqual(["new.txt"]);
    expect(service.getStatusSnapshot()).toBe(reported[0]!);
  }, 20000);
});

describe("ProjectFilesService refresh coalescing", () => {
  test("a burst of requests costs at most two passes and delivers every change", async () => {
    const repo = await seedRepo();
    let passes = 0;
    const changed: string[] = [];
    const service = new ProjectFilesService(
      repo,
      () => {},
      (filePath) => changed.push(path.basename(filePath)),
      () => {
        passes++;
      },
    );
    cleanups.push(() => service.stop());

    const keys = Array.from({ length: 20 }, (_, i) => `f${i}.txt`);
    await Promise.all([
      ...keys.map((key) => service.notifyChanges([key])),
      service.refreshGitStatus(),
      service.refreshGitStatus(),
    ]);

    // The first request starts a pass; everything else lands in one follow-up.
    expect(passes).toBeLessThanOrEqual(2);
    expect(changed.sort()).toEqual([...keys].sort());
  }, 20000);

  test("stop() releases callers waiting on a queued pass", async () => {
    const repo = await seedRepo();
    const service = new ProjectFilesService(repo, () => {});
    const first = service.notifyChanges(["a.txt"]);
    const queued = service.notifyChanges(["b.txt"]);
    service.stop();

    const timeout = Bun.sleep(5000).then(() => "timeout" as const);
    const settled = Promise.all([first, queued]).then(() => "settled" as const);
    expect(await Promise.race([settled, timeout])).toBe("settled");
  }, 20000);
});

describe("ProjectFilesService tree status", () => {
  test("colors entries whose names git would C-quote", async () => {
    const repo = await seedRepo();
    await Bun.write(path.join(repo, "sp ace.txt"), "s\n");
    await Bun.$`git -C ${repo} add -A`.quiet();
    await Bun.$`git -C ${repo} -c user.email=t@t -c user.name=t commit -q -m more`.quiet();
    await Bun.write(path.join(repo, "sp ace.txt"), "changed\n");
    await Bun.write(path.join(repo, "ünï.txt"), "u\n");
    await Bun.write(path.join(repo, 'q"uote.txt'), "q\n");
    await Bun.write(path.join(repo, ".gitignore"), "ïgnored/\nnew-dir/ïgn.log\n");
    await Bun.write(path.join(repo, "ïgnored", "x.txt"), "x\n");
    await Bun.write(path.join(repo, "new-dir", "ïgn.log"), "i\n");
    await Bun.write(path.join(repo, "new-dir", "kept.txt"), "k\n");

    const service = new ProjectFilesService(repo, () => {});
    cleanups.push(() => service.stop());
    await service.start();

    const root = Object.fromEntries(
      (await service.getDirContents("")).map((entry) => [entry.name, entry.status]),
    );
    expect(root).toMatchObject({
      "sp ace.txt": "modified",
      "ünï.txt": "untracked",
      'q"uote.txt': "untracked",
      ïgnored: "ignored",
      "new-dir": "untracked",
      "a.txt": "normal",
    });
    // Inside an untracked directory, ignored children are found via `check-ignore -z`.
    const inside = Object.fromEntries(
      (await service.getDirContents("new-dir")).map((entry) => [entry.name, entry.status]),
    );
    expect(inside).toEqual({ "ïgn.log": "ignored", "kept.txt": "untracked" });
  }, 20000);
});

describe("ProjectFilesService move reporting", () => {
  test("reports a tracked file's rename as a move before the change events", async () => {
    const repo = await seedRepo();
    const events: string[] = [];
    const service = new ProjectFilesService(
      repo,
      () => {},
      (filePath) => events.push(`changed ${path.basename(filePath)}`),
      undefined,
      {
        onFileMoved: (oldPath, newPath, source) =>
          events.push(`moved ${path.basename(oldPath)} ${path.basename(newPath)} ${source}`),
      },
    );
    cleanups.push(() => service.stop());
    await service.start();
    await service.trackFile("a.txt");

    await Bun.$`mv ${path.join(repo, "a.txt")} ${path.join(repo, "b.txt")}`.quiet();
    await service.notifyChanges(["a.txt", "b.txt"]);

    const moved = events.indexOf("moved a.txt b.txt external");
    expect(moved).not.toBe(-1);
    // The old path is still reported (the diff view needs it); editors ignore it once moved.
    expect(events.indexOf("changed a.txt")).toBeGreaterThan(moved);
  }, 20000);

  test("attributes a move made during a Loxel operation to Loxel", async () => {
    const repo = await seedRepo();
    const sources: string[] = [];
    const service = new ProjectFilesService(repo, () => {}, undefined, undefined, {
      onFileMoved: (_old, _new, source) => sources.push(source),
    });
    cleanups.push(() => service.stop());
    await service.start();
    await service.trackFile("a.txt");

    const end = service.beginOperation();
    await Bun.$`mv ${path.join(repo, "a.txt")} ${path.join(repo, "b.txt")}`.quiet();
    end();
    await service.notifyChanges(["a.txt", "b.txt"]);

    expect(sources).toContain("loxel");
    expect(sources).not.toContain("external");
  }, 20000);
});

describe("ProjectFilesService changed paths", () => {
  test("reports absolute changed paths outside git-ignored directories", async () => {
    const repo = await seedRepo();
    await Bun.write(path.join(repo, ".gitignore"), ".venv/\n");
    await Bun.write(path.join(repo, ".venv", "pyvenv.cfg"), "home = /usr/bin\n");
    const reported = new Set<string>();
    const service = new ProjectFilesService(repo, () => {}, undefined, undefined, {
      onPathsChanged: (paths) => {
        for (const p of paths) reported.add(p);
      },
    });
    cleanups.push(() => service.stop());
    await service.start();
    await Bun.sleep(300);
    reported.clear();

    await Bun.write(path.join(repo, ".venv", "lib.py"), "x = 1\n");
    await Bun.write(path.join(repo, "main.py"), "y = 1\n");

    const deadline = Date.now() + 8000;
    while (!reported.has(path.join(repo, "main.py")) && Date.now() < deadline) await Bun.sleep(50);
    await Bun.sleep(200);
    expect(reported.has(path.join(repo, "main.py"))).toBe(true);
    expect([...reported].filter((p) => p.includes(".venv"))).toEqual([]);
  }, 20000);
});
