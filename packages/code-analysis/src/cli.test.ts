import { expect, test } from "bun:test";
import { symlink } from "node:fs/promises";
import { join } from "node:path";

import { git, installFakeBin, withWorkDir } from "./test-workdir.ts";

const CLI = join(import.meta.dir, "cli.ts");

test("a symlinked workdir finds the repository's tool and gets clean paths", async () => {
  await withWorkDir({ "tsconfig.json": "{}", "packages/app/a.js": "" }, async (workDir) => {
    await git(workDir, "init", "-q");
    await installFakeBin(workDir, "tsc", 'echo "a.js(1,1): error TS1: bad"; exit 1');
    const link = join(workDir, "..", `${crypto.randomUUID()}-link`);
    await symlink(join(workDir, "packages/app"), link);
    try {
      const proc = Bun.spawn([process.execPath, CLI, "-p", "type-issues", "-w", link, "--json"], {
        stdout: "pipe",
        stderr: "ignore",
      });
      const records: unknown = JSON.parse(await new Response(proc.stdout).text());
      expect(records).toEqual([{ path: "a.js", code: "TS1", message: "bad", count: 1 }]);
    } finally {
      await Bun.$`rm ${link}`;
    }
  });
});
