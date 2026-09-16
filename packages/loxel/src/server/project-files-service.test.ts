import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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

  test("a git-dir driven refresh does not report a status change", async () => {
    const repo = await seedRepo();
    let notified = 0;
    const service = new ProjectFilesService(
      repo,
      () => {},
      undefined,
      () => {
        notified++;
      },
    );
    cleanups.push(() => service.stop());
    await service.start();

    await service.refreshGitStatus();

    expect(notified).toBe(0);
  }, 20000);
});
