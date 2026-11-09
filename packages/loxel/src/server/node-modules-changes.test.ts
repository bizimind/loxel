import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { dependencyChangePaths, NodeModulesChanges } from "./node-modules-changes";

describe("dependencyChangePaths", () => {
  test("reports the package directory and package.json for any file in it", () => {
    expect(dependencyChangePaths("node_modules/foo/lib/index.js")).toEqual({
      packagePaths: ["node_modules/foo", "node_modules/foo/package.json"],
      typeFile: null,
      packageDir: "node_modules/foo",
      isPackageEntry: false,
    });
  });

  test("reports a changed type file too, so an in-place upgrade reloads it", () => {
    for (const file of ["index.d.ts", "index.d.mts", "src/a.ts", "src/b.tsx", "tsconfig.json"]) {
      expect(dependencyChangePaths(`node_modules/foo/${file}`)?.typeFile).toBe(
        `node_modules/foo/${file}`,
      );
    }
    expect(dependencyChangePaths("node_modules/foo/package.json")?.typeFile).toBeNull();
  });

  test("reports a package entry itself, such as a pnpm symlink", () => {
    expect(dependencyChangePaths("node_modules/foo")).toEqual({
      packagePaths: ["node_modules/foo", "node_modules/foo/package.json"],
      typeFile: null,
      packageDir: "node_modules/foo",
      isPackageEntry: true,
    });
  });

  test("handles scoped packages and bare scope directories", () => {
    expect(dependencyChangePaths("node_modules/@types/node/fs.d.ts")).toEqual({
      packagePaths: ["node_modules/@types/node", "node_modules/@types/node/package.json"],
      typeFile: "node_modules/@types/node/fs.d.ts",
      packageDir: "node_modules/@types/node",
      isPackageEntry: false,
    });
    expect(dependencyChangePaths("node_modules/@types/node")?.isPackageEntry).toBe(true);
    expect(dependencyChangePaths("node_modules/@types")).toEqual({
      packagePaths: ["node_modules/@types", "node_modules/@types/package.json"],
      typeFile: null,
      packageDir: "node_modules/@types",
      isPackageEntry: false,
    });
  });

  test("keeps the directory prefix of a workspace package's node_modules", () => {
    expect(dependencyChangePaths("packages/app/node_modules/foo")?.packagePaths).toEqual([
      "packages/app/node_modules/foo",
      "packages/app/node_modules/foo/package.json",
    ]);
  });

  test("reports the package at every node_modules level", () => {
    const change = dependencyChangePaths("node_modules/a/node_modules/@s/b/x.js");
    expect(change?.packagePaths).toEqual([
      "node_modules/a",
      "node_modules/a/package.json",
      "node_modules/a/node_modules/@s/b",
      "node_modules/a/node_modules/@s/b/package.json",
    ]);
    expect(change?.packageDir).toBe("node_modules/a/node_modules/@s/b");
  });

  test("skips node_modules itself, dot entries and paths outside node_modules", () => {
    for (const relPath of [
      "node_modules",
      "node_modules/.pnpm/foo@1.0.0/node_modules/foo/index.d.ts",
      "node_modules/.bin/tsc",
      "node_modules/.package-lock.json",
      "node_modules/.modules.yaml",
      "node_modules/.cache/x",
      "node_modules/@scope/.foo-a1b2/index.d.ts",
      "dist/index.d.ts",
    ]) {
      expect(dependencyChangePaths(relPath)).toBeNull();
    }
  });

  test("stops at a dot entry in a nested node_modules", () => {
    expect(dependencyChangePaths("node_modules/a/node_modules/.bin/x")?.packagePaths).toEqual([
      "node_modules/a",
      "node_modules/a/package.json",
    ]);
  });
});

describe("NodeModulesChanges", () => {
  const disposers: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const dispose of disposers.splice(0)) await dispose();
  });

  function collector(root: string, quietMs: number, maxWaitMs: number) {
    let resolveNext: (paths: string[]) => void = () => {};
    const changes = new NodeModulesChanges(root, (paths) => resolveNext(paths), quietMs, maxWaitMs);
    disposers.push(() => changes.dispose());
    const next = () =>
      new Promise<string[]>((resolve) => {
        resolveNext = resolve;
      });
    return { changes, next };
  }

  async function tempRoot(): Promise<string> {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "node-modules-changes-")));
    disposers.push(() => rm(root, { recursive: true, force: true }));
    return root;
  }

  test("reports a burst once, as deduplicated absolute paths", async () => {
    const { changes, next } = collector("/wt", 0, 60_000);
    const sent = next();
    changes.add("node_modules/foo/index.d.ts");
    changes.add("node_modules/foo/lib/a.js");
    changes.add("node_modules/.pnpm/bar@1.0.0/node_modules/bar/index.js");
    changes.add("node_modules/.modules.yaml");
    changes.add("node_modules/bar");
    expect(await sent).toEqual([
      "/wt/node_modules/foo",
      "/wt/node_modules/foo/package.json",
      "/wt/node_modules/foo/index.d.ts",
      "/wt/node_modules/bar",
      "/wt/node_modules/bar/package.json",
    ]);
  });

  test("reports by the maximum wait while changes keep coming", async () => {
    const { changes, next } = collector("/wt", 60_000, 0);
    const sent = next();
    changes.add("node_modules/foo/index.js");
    expect(await sent).toEqual(["/wt/node_modules/foo", "/wt/node_modules/foo/package.json"]);
  });

  test("lists the type files of a package directory replaced as a whole", async () => {
    const root = await tempRoot();
    const pkg = path.join(root, "node_modules", "bar");
    await mkdir(path.join(pkg, "lib", ".cache"), { recursive: true });
    for (const file of [
      "package.json",
      "index.d.ts",
      "index.js",
      "lib/a.d.ts",
      "lib/.cache/b.ts",
    ]) {
      await writeFile(path.join(pkg, file), "");
    }
    const { changes, next } = collector(root, 0, 60_000);
    const sent = next();
    changes.add("node_modules/bar");
    expect((await sent).toSorted()).toEqual(
      [
        "node_modules/bar",
        "node_modules/bar/package.json",
        "node_modules/bar/index.d.ts",
        "node_modules/bar/lib/a.d.ts",
      ]
        .map((p) => path.join(root, p))
        .toSorted(),
    );
  });

  test("does not list a package with events inside it, or a symlinked one", async () => {
    const root = await tempRoot();
    for (const name of ["written", "target"]) {
      await mkdir(path.join(root, "node_modules", name), { recursive: true });
      await writeFile(path.join(root, "node_modules", name, "index.d.ts"), "");
    }
    await symlink("target", path.join(root, "node_modules", "linked"));
    const { changes, next } = collector(root, 0, 60_000);
    const sent = next();
    changes.add("node_modules/written");
    changes.add("node_modules/written/package.json");
    changes.add("node_modules/linked");
    expect(await sent).toEqual(
      [
        "node_modules/written",
        "node_modules/written/package.json",
        "node_modules/linked",
        "node_modules/linked/package.json",
      ].map((p) => path.join(root, p)),
    );
  });
});
