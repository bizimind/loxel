import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  csharpRestoreState,
  discoverCSharpProjects,
  dotnetRuntimes,
  dotnetSdkVersion,
  inspectGlobalJson,
  isDotnetSafeToRun,
  prepareDotnet,
  refreshCSharpRestore,
  resolveDotnet,
  subscribeCSharpRestore,
  type CSharpRestoreUpdate,
} from "./csharp-env";

// Each test spawns git many times; how fast is not what these test.
setDefaultTimeout(120_000);

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

/** A git worktree, and directories outside it, under a fresh temp root. */
async function makeRoot(): Promise<{ wt: string; outside: string; bin: string }> {
  root = await realpath(await mkdtemp(join(tmpdir(), "csharp-env-")));
  const wt = join(root, "wt");
  const outside = join(root, "outside");
  const bin = join(root, "bin");
  await Promise.all([mkdir(wt), mkdir(outside), mkdir(bin)]);
  await git(wt, "init", "-q");
  return { wt, outside, bin };
}

async function write(file: string, content = ""): Promise<string> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
  return file;
}

async function commitAll(wt: string): Promise<void> {
  await git(wt, "add", "-A");
  await git(
    wt,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.com",
    "commit",
    "-qm",
    "x",
    "--allow-empty",
  );
}

/**
 * A fake `dotnet` that records each run's arguments and directory in `<script>.runs`, reports
 * `version` for `--version`, and prints `runtimes` for `--list-runtimes`.
 */
async function fakeDotnet(
  dir: string,
  { version = "10.0.403", runtimes = "" }: { version?: string; runtimes?: string } = {},
): Promise<{ dotnet: string; runs: () => Promise<string[]> }> {
  const dotnet = join(dir, "dotnet");
  const log = `${dotnet}.runs`;
  await write(
    dotnet,
    `#!/bin/sh
echo "$1 $(pwd -P)" >> '${log}'
case "$1" in
  --version) echo '${version}' ;;
  --list-runtimes) printf '%b' '${runtimes}' ;;
esac
`,
  );
  await chmod(dotnet, 0o755);
  const runs = async () => {
    const file = Bun.file(log);
    return (await file.exists()) ? (await file.text()).split("\n").filter(Boolean) : [];
  };
  return { dotnet, runs };
}

describe("resolveDotnet", () => {
  test("finds dotnet on PATH, skipping the worktree's own directories", async () => {
    const { wt, bin } = await makeRoot();
    const { dotnet } = await fakeDotnet(bin);
    await fakeDotnet(join(wt, "tools"));
    const env = { PATH: [join(wt, "tools"), bin].join(":") };
    expect(await resolveDotnet(wt, { env })).toBe(dotnet);
  });

  test("returns null with no dotnet at all", async () => {
    const { wt, bin } = await makeRoot();
    expect(await resolveDotnet(wt, { env: { PATH: bin } })).toBeNull();
  });

  test("falls back to DOTNET_ROOT, and PATH wins over it as for the host", async () => {
    const { wt, bin, outside } = await makeRoot();
    const { dotnet: rooted } = await fakeDotnet(outside);
    expect(await resolveDotnet(wt, { env: { PATH: bin, DOTNET_ROOT: outside } })).toBe(rooted);

    const { dotnet: onPath } = await fakeDotnet(bin);
    expect(await resolveDotnet(wt, { env: { PATH: bin, DOTNET_ROOT: outside } })).toBe(onPath);
  });

  test("the architecture's DOTNET_ROOT wins over DOTNET_ROOT", async () => {
    const { wt, bin, outside } = await makeRoot();
    const { dotnet } = await fakeDotnet(outside);
    const env = {
      PATH: bin,
      DOTNET_ROOT: join(root!, "missing"),
      [`DOTNET_ROOT_${process.arch.toUpperCase()}`]: outside,
    };
    expect(await resolveDotnet(wt, { env })).toBe(dotnet);
  });

  test("a DOTNET_ROOT inside the worktree does not count", async () => {
    const { wt, bin } = await makeRoot();
    await fakeDotnet(join(wt, ".dotnet"));
    const env = { PATH: bin, DOTNET_ROOT: join(wt, ".dotnet") };
    expect(await resolveDotnet(wt, { env })).toBeNull();
  });

  test("a symlink on PATH leading into the worktree does not count", async () => {
    const { wt, bin } = await makeRoot();
    const { dotnet } = await fakeDotnet(join(wt, "tools"));
    await symlink(dotnet, join(bin, "dotnet"));
    expect(await resolveDotnet(wt, { env: { PATH: bin } })).toBeNull();
  });

  test("a relative PATH entry does not count", async () => {
    const { wt, bin, outside } = await makeRoot();
    await fakeDotnet(outside);
    expect(await resolveDotnet(wt, { env: { PATH: `../outside:${bin}` } })).toBeNull();
  });

  test("does not throw for a worktree that does not exist", async () => {
    const { bin } = await makeRoot();
    await fakeDotnet(bin);
    expect(await resolveDotnet(join(root!, "gone"), { env: { PATH: bin } })).toBeNull();
  });
});

describe("inspectGlobalJson", () => {
  test("returns null when no file applies", async () => {
    const { wt } = await makeRoot();
    expect(await inspectGlobalJson(wt, wt, { env: { PATH: "" } })).toBeNull();
  });

  test("reports the SDK settings, resolving paths against the file's directory", async () => {
    const { wt, bin } = await makeRoot();
    const { dotnet } = await fakeDotnet(bin);
    const file = await write(
      join(wt, "global.json"),
      JSON.stringify({
        sdk: {
          version: "10.0.100",
          rollForward: "latestFeature",
          paths: [".dotnet", "$host$", "/opt/sdk"],
        },
      }),
    );
    const info = await inspectGlobalJson(wt, wt, { env: { PATH: bin } });
    expect(info).toEqual({
      path: file,
      valid: true,
      sdkVersion: "10.0.100",
      rollForward: "latestFeature",
      sdkPaths: [
        { entry: ".dotnet", path: join(wt, ".dotnet"), insideWorktree: true, tracked: false },
        { entry: "$host$", path: dirname(dotnet), insideWorktree: false, tracked: false },
        { entry: "/opt/sdk", path: "/opt/sdk", insideWorktree: false, tracked: false },
      ],
    });
  });

  test("walks up from a subdirectory, and through a symlinked directory physically", async () => {
    const { wt, outside } = await makeRoot();
    const file = await write(join(wt, "global.json"), '{"sdk":{"version":"8.0.100"}}');
    await mkdir(join(wt, "src", "app"), { recursive: true });
    const env = { PATH: "" };
    expect((await inspectGlobalJson(wt, join(wt, "src", "app"), { env }))?.path).toBe(file);

    const link = join(outside, "link");
    await symlink(join(wt, "src"), link);
    expect((await inspectGlobalJson(wt, link, { env }))?.path).toBe(file);
  });

  test("stops at the nearest file, even an invalid one", async () => {
    const { wt } = await makeRoot();
    await write(join(wt, "global.json"), '{"sdk":{"version":"8.0.100"}}');
    const nearest = await write(join(wt, "src", "global.json"), "{not json");
    const info = await inspectGlobalJson(wt, join(wt, "src"), { env: { PATH: "" } });
    expect(info).toMatchObject({ path: nearest, valid: false });
  });

  test("reads what the host's parser reads: a BOM and comments", async () => {
    const { wt } = await makeRoot();
    await write(
      join(wt, "global.json"),
      '﻿// a "comment"\n{ /* x */ "sdk": { "version": "8.0.100", "rollForward": "disable//" } } // end',
    );
    expect(await inspectGlobalJson(wt, wt, { env: { PATH: "" } })).toMatchObject({
      valid: true,
      sdkVersion: "8.0.100",
      rollForward: "disable//",
      sdkPaths: null,
    });
  });

  test("ignores non-string paths like the host, and key casing is exact", async () => {
    const { wt } = await makeRoot();
    await write(join(wt, "global.json"), '{"sdk":{"paths":[1,"a",null],"Version":"1.0.0"}}');
    const info = await inspectGlobalJson(wt, wt, { env: { PATH: "" } });
    expect(info?.sdkVersion).toBeNull();
    expect(info?.sdkPaths?.map((sdkPath) => sdkPath.entry)).toEqual(["a"]);
  });

  test("an absent sdk section is valid and empty", async () => {
    const { wt } = await makeRoot();
    await write(join(wt, "global.json"), '{"msbuild-sdks":{"Cake.Sdk":"6.3.0"}}');
    expect(await inspectGlobalJson(wt, wt, { env: { PATH: "" } })).toMatchObject({
      valid: true,
      sdkVersion: null,
      sdkPaths: null,
    });
  });
});

describe("isDotnetSafeToRun", () => {
  async function trackedSdk(wt: string): Promise<void> {
    await write(join(wt, ".dotnet", "sdk", "10.0.999", "dotnet.dll"));
    await write(join(wt, "global.json"), '{"sdk":{"paths":[".dotnet","$host$"]}}');
    await commitAll(wt);
  }

  test("with no global.json, or one without sdk.paths", async () => {
    const { wt } = await makeRoot();
    expect(await isDotnetSafeToRun(wt, { env: { PATH: "" } })).toBe(true);
    await write(join(wt, "global.json"), '{"sdk":{"version":"10.0.100"}}');
    await commitAll(wt);
    expect(await isDotnetSafeToRun(wt, { env: { PATH: "" } })).toBe(true);
  });

  test("not when git tracks something under an sdk.paths entry", async () => {
    const { wt } = await makeRoot();
    await trackedSdk(wt);
    expect(await isDotnetSafeToRun(wt, { env: { PATH: "" } })).toBe(false);
  });

  test("with an untracked SDK a build script installed, and with one not installed", async () => {
    const { wt } = await makeRoot();
    await write(join(wt, ".gitignore"), ".dotnet/\n");
    await write(join(wt, "global.json"), '{"sdk":{"paths":[".dotnet","$host$"]}}');
    await commitAll(wt);
    expect(await isDotnetSafeToRun(wt, { env: { PATH: "" } })).toBe(true);
    await write(join(wt, ".dotnet", "sdk", "10.0.999", "dotnet.dll"));
    expect(await isDotnetSafeToRun(wt, { env: { PATH: "" } })).toBe(true);
  });

  test("not for a global.json in a subfolder with a tracked SDK", async () => {
    const { wt } = await makeRoot();
    await write(join(wt, "src", ".dotnet", "sdk", "1.0.0", "dotnet.dll"));
    await write(join(wt, "src", "global.json"), '{"sdk":{"paths":[".dotnet"]}}');
    await commitAll(wt);
    expect(await isDotnetSafeToRun(wt, { env: { PATH: "" } })).toBe(false);
  });

  test("not for a global.json above the worktree whose SDK its own repository tracks", async () => {
    const { wt } = await makeRoot();
    await write(join(wt, ".dotnet", "sdk", "1.0.0", "dotnet.dll"));
    await write(join(wt, "global.json"), '{"sdk":{"paths":[".dotnet"]}}');
    await write(join(wt, ".gitignore"), "nested/\n");
    await commitAll(wt);
    const nested = join(wt, "nested");
    await mkdir(nested);
    await git(nested, "init", "-q");
    expect(await isDotnetSafeToRun(nested, { env: { PATH: "" } })).toBe(false);
  });

  test("checks the applying file of cwd even when git does not list it", async () => {
    const { wt } = await makeRoot();
    await write(join(wt, ".gitignore"), "vendor/\n");
    await write(join(wt, ".dotnet", "sdk", "1.0.0", "dotnet.dll"));
    await write(join(wt, "vendor", "global.json"), '{"sdk":{"paths":["../.dotnet"]}}');
    await commitAll(wt);
    const env = { PATH: "" };
    expect(await isDotnetSafeToRun(wt, { env })).toBe(true);
    expect(await isDotnetSafeToRun(wt, { env, cwd: join(wt, "vendor") })).toBe(false);
  });

  test("reads a large repetitive global.json in one pass", async () => {
    const { wt } = await makeRoot();
    await write(join(wt, "global.json"), "/*".repeat(512 * 1024 - 8));
    expect(await isDotnetSafeToRun(wt, { env: { PATH: "" } })).toBe(false);
  });

  test("not when a file can be read differently from the host", async () => {
    const { wt } = await makeRoot();
    for (const content of [
      "{not json",
      '{"sdk":{"paths":["a"],}}',
      '{"sdk":{"paths":"a"}}',
      '{"sdk":1}',
      '{"sdk":{"paths":["a"],"paths":[]}}',
      '{"sdk":{"paths":["a"]},"sdk":{}}',
      '{"s\\u0064k":{},"sdk":{}}',
      '{"sdk":{"paths":[]}} trailing',
      '{"sdk":{"version":"1.0.0","version":"2.0.0"}}',
      "/* unterminated",
    ]) {
      await write(join(wt, "global.json"), content);
      expect(await isDotnetSafeToRun(wt, { env: { PATH: "" } })).toBe(false);
    }
  });

  test("not for invalid bytes, nor a directory named global.json", async () => {
    const { wt } = await makeRoot();
    await writeFile(join(wt, "global.json"), new Uint8Array([0x7b, 0xff, 0x7d]));
    expect(await isDotnetSafeToRun(wt, { env: { PATH: "" } })).toBe(false);
    await rm(join(wt, "global.json"));
    await mkdir(join(wt, "global.json"));
    expect(await isDotnetSafeToRun(wt, { env: { PATH: "" } })).toBe(false);
  });

  test("not for a tracked symlink as an entry or on the way to one", async () => {
    const { wt, outside } = await makeRoot();
    await mkdir(join(outside, "x", "inner"), { recursive: true });
    await symlink(join(outside, "x"), join(wt, "link"));
    await write(join(wt, "global.json"), '{"sdk":{"paths":["link"]}}');
    await commitAll(wt);
    expect(await isDotnetSafeToRun(wt, { env: { PATH: "" } })).toBe(false);

    await write(join(wt, "global.json"), '{"sdk":{"paths":["link/inner"]}}');
    expect(await isDotnetSafeToRun(wt, { env: { PATH: "" } })).toBe(false);

    await write(join(wt, "global.json"), '{"sdk":{"paths":["link/../elsewhere"]}}');
    expect(await isDotnetSafeToRun(wt, { env: { PATH: "" } })).toBe(false);
  });

  test("not for a dangling tracked symlink", async () => {
    const { wt, outside } = await makeRoot();
    await symlink(join(outside, "missing"), join(wt, "link"));
    await write(join(wt, "global.json"), '{"sdk":{"paths":["link"]}}');
    await commitAll(wt);
    expect(await isDotnetSafeToRun(wt, { env: { PATH: "" } })).toBe(false);
  });

  test("not for an entry holding the worktree, whose own name can be sdk", async () => {
    const { outside } = await makeRoot();
    const wt = join(outside, "sdk");
    await mkdir(wt);
    await git(wt, "init", "-q");
    await write(join(wt, "99.0.0", "dotnet.dll"));
    await write(join(wt, "global.json"), '{"sdk":{"paths":[".."]}}');
    await commitAll(wt);
    expect(await isDotnetSafeToRun(wt, { env: { PATH: "" } })).toBe(false);
  });

  test("not when git cannot list a repository's files", async () => {
    const { wt } = await makeRoot();
    await write(join(wt, "main.ts"));
    await commitAll(wt);
    expect(await isDotnetSafeToRun(wt, { env: { PATH: "" } })).toBe(true);
    await writeFile(join(wt, ".git", "index"), "not an index");
    expect(await isDotnetSafeToRun(wt, { env: { PATH: "" } })).toBe(false);
  });

  test("in a directory in no git repository", async () => {
    const { outside } = await makeRoot();
    expect(await isDotnetSafeToRun(outside, { env: { PATH: "" } })).toBe(true);
  });

  test("checks any casing of the file name that git lists", async () => {
    const { wt } = await makeRoot();
    await write(join(wt, "src", ".dotnet", "sdk", "1.0.0", "dotnet.dll"));
    await write(join(wt, "src", "GLOBAL.JSON"), '{"sdk":{"paths":[".dotnet"]}}');
    await commitAll(wt);
    expect(await isDotnetSafeToRun(wt, { env: { PATH: "" } })).toBe(false);
  });

  test("not for a global.json that is a symlink to something other than a file", async () => {
    const { wt } = await makeRoot();
    await symlink("/dev/zero", join(wt, "global.json"));
    expect(await isDotnetSafeToRun(wt, { env: { PATH: "" } })).toBe(false);
  });

  test("not for a global.json too large to be a real one", async () => {
    const { wt } = await makeRoot();
    await write(join(wt, "global.json"), " ".repeat(1024 * 1024 + 1));
    expect(await isDotnetSafeToRun(wt, { env: { PATH: "" } })).toBe(false);
  });

  test("for a worktree opened through a symlink", async () => {
    const { wt, outside } = await makeRoot();
    await write(join(wt, "main.ts"));
    await write(join(wt, "global.json"), '{"sdk":{"paths":[".dotnet"]}}');
    await commitAll(wt);
    const link = join(outside, "link");
    await symlink(wt, link);
    expect(await isDotnetSafeToRun(link, { env: { PATH: "" } })).toBe(true);
  });

  test("a tracked global.json deleted from disk applies to nothing", async () => {
    const { wt } = await makeRoot();
    await write(join(wt, "src", "global.json"), '{"sdk":{"version":"10.0.100"}}');
    await commitAll(wt);
    await rm(join(wt, "src", "global.json"));
    expect(await isDotnetSafeToRun(wt, { env: { PATH: "" } })).toBe(true);
  });

  test("not for a directory that does not exist", async () => {
    const { outside } = await makeRoot();
    expect(await isDotnetSafeToRun(join(outside, "gone"), { env: { PATH: "" } })).toBe(false);
  });
});

describe("prepareDotnet and dotnetSdkVersion", () => {
  test("prepareDotnet returns the dotnet with its environment only after the check", async () => {
    const { wt, bin } = await makeRoot();
    const { dotnet } = await fakeDotnet(bin);
    const env = { PATH: `${join(wt, "tools")}:${bin}` };
    expect(await prepareDotnet(wt, { env })).toEqual({
      dotnetPath: dotnet,
      env: { PATH: bin, DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1" },
      cwd: wt,
    });

    await write(join(wt, ".dotnet", "a"));
    await write(join(wt, "global.json"), '{"sdk":{"paths":[".dotnet"]}}');
    await commitAll(wt);
    expect(await prepareDotnet(wt, { env })).toBeNull();
  });

  test("does not run dotnet at all when the check does not pass", async () => {
    const { wt, bin } = await makeRoot();
    const { runs } = await fakeDotnet(bin);
    await write(join(wt, ".dotnet", "sdk", "1.0.0", "dotnet.dll"));
    await write(join(wt, "global.json"), '{"sdk":{"paths":[".dotnet"]}}');
    await commitAll(wt);
    expect(await dotnetSdkVersion(wt, { env: { PATH: bin } })).toBeNull();
    expect(await runs()).toEqual([]);
  });

  test("the check runs before the cache", async () => {
    const { wt, bin } = await makeRoot();
    const { runs } = await fakeDotnet(bin);
    expect(await dotnetSdkVersion(wt, { env: { PATH: bin } })).toBe("10.0.403");
    await write(join(wt, ".dotnet", "sdk", "1.0.0", "dotnet.dll"));
    await write(join(wt, "global.json"), '{"sdk":{"paths":[".dotnet"]}}');
    await commitAll(wt);
    expect(await dotnetSdkVersion(wt, { env: { PATH: bin } })).toBeNull();
    expect(await runs()).toHaveLength(1);
  });

  test("reads the version once, from the worktree, and again when global.json changes", async () => {
    const { wt, bin } = await makeRoot();
    const { runs } = await fakeDotnet(bin);
    expect(await dotnetSdkVersion(wt, { env: { PATH: bin } })).toBe("10.0.403");
    expect(await dotnetSdkVersion(wt, { env: { PATH: bin } })).toBe("10.0.403");
    expect(await runs()).toEqual([`--version ${wt}`]);

    await write(join(wt, "global.json"), '{"sdk":{"version":"10.0.100"}}');
    await dotnetSdkVersion(wt, { env: { PATH: bin } });
    expect(await runs()).toHaveLength(2);
  });

  test("returns null with no dotnet, and for output that is not a version", async () => {
    const { wt, bin } = await makeRoot();
    expect(await dotnetSdkVersion(wt, { env: { PATH: bin } })).toBeNull();
    await fakeDotnet(bin, { version: "The command could not be loaded" });
    expect(await dotnetSdkVersion(wt, { env: { PATH: bin } })).toBeNull();
  });

  test("does not cache a failed read", async () => {
    const { wt, bin } = await makeRoot();
    await fakeDotnet(bin, { version: "nope" });
    expect(await dotnetSdkVersion(wt, { env: { PATH: bin } })).toBeNull();
    await fakeDotnet(bin, { version: "8.0.427" });
    expect(await dotnetSdkVersion(wt, { env: { PATH: bin } })).toBe("8.0.427");
  });
});

describe("dotnetRuntimes", () => {
  const listing = (rootDir: string, version: string) =>
    `Microsoft.AspNetCore.App ${version} [${rootDir}/shared/Microsoft.AspNetCore.App]\\nMicrosoft.NETCore.App ${version} [${rootDir}/shared/Microsoft.NETCore.App]\\n`;

  test("finds a modern runtime under DOTNET_ROOT next to an older SDK on PATH", async () => {
    const { wt, bin, outside } = await makeRoot();
    await fakeDotnet(bin, { runtimes: listing(bin, "8.0.33") });
    await fakeDotnet(outside, { runtimes: listing(outside, "10.0.14") });
    expect(await dotnetRuntimes(wt, { env: { PATH: bin, DOTNET_ROOT: outside } })).toEqual({
      runtimes: [
        { version: "10.0.14", root: outside },
        { version: "8.0.33", root: bin },
      ],
      runtime10Root: outside,
    });
  });

  test("an older runtime only is not enough; a higher major is", async () => {
    const { wt, bin, outside } = await makeRoot();
    await fakeDotnet(bin, { runtimes: listing(bin, "8.0.33") });
    expect((await dotnetRuntimes(wt, { env: { PATH: bin } }))?.runtime10Root).toBeNull();
    await fakeDotnet(outside, { runtimes: listing(outside, "11.0.0-preview.1") });
    expect((await dotnetRuntimes(wt, { env: { PATH: outside } }))?.runtime10Root).toBe(outside);
  });

  test("asks one install once when a symlink on PATH leads into DOTNET_ROOT", async () => {
    const { wt, bin, outside } = await makeRoot();
    const { dotnet, runs } = await fakeDotnet(outside, { runtimes: listing(outside, "10.0.14") });
    await symlink(dotnet, join(bin, "dotnet"));
    expect(await dotnetRuntimes(wt, { env: { PATH: bin, DOTNET_ROOT: outside } })).toEqual({
      runtimes: [{ version: "10.0.14", root: outside }],
      runtime10Root: outside,
    });
    expect(await runs()).toHaveLength(1);
  });

  test("returns null without dotnet", async () => {
    const { wt, bin } = await makeRoot();
    expect(await dotnetRuntimes(wt, { env: { PATH: bin } })).toBeNull();
  });

  test("asks from outside the worktree, even when dotnet may not run in it", async () => {
    const { wt, bin } = await makeRoot();
    const { runs } = await fakeDotnet(bin, { runtimes: listing(bin, "10.0.14") });
    await write(join(wt, ".dotnet", "sdk", "1.0.0", "dotnet.dll"));
    await write(join(wt, "global.json"), '{"sdk":{"paths":[".dotnet"]}}');
    await commitAll(wt);
    expect((await dotnetRuntimes(wt, { env: { PATH: bin } }))?.runtime10Root).toBe(bin);
    const [run] = await runs();
    expect(run).toBe(`--list-runtimes ${await realpath(tmpdir())}`);
  });

  test("lists once per install", async () => {
    const { wt, bin } = await makeRoot();
    const { runs } = await fakeDotnet(bin, { runtimes: listing(bin, "10.0.14") });
    await dotnetRuntimes(wt, { env: { PATH: bin } });
    await dotnetRuntimes(wt, { env: { PATH: bin } });
    expect(await runs()).toHaveLength(1);
  });
});

describe("discoverCSharpProjects", () => {
  test("uses the only root solution, and lists the rest", async () => {
    const { wt } = await makeRoot();
    const solution = await write(join(wt, "App.slnx"));
    const filter = await write(join(wt, "App.slnf"));
    const project = await write(join(wt, "src", "App", "App.csproj"));
    expect(await discoverCSharpProjects(wt)).toEqual({
      solutions: [solution],
      solutionFilters: [filter],
      projects: [project],
      defaultTarget: { kind: "solution", path: solution },
    });
  });

  test("falls back to the projects with two root solutions, or none", async () => {
    const { wt } = await makeRoot();
    const sln = await write(join(wt, "App.sln"));
    const slnx = await write(join(wt, "App.slnx"));
    const project = await write(join(wt, "App.csproj"));
    let found = await discoverCSharpProjects(wt);
    expect(found.solutions).toEqual([sln, slnx]);
    expect(found.defaultTarget).toEqual({ kind: "projects", paths: [project] });

    await rm(sln);
    await rm(slnx);
    found = await discoverCSharpProjects(wt);
    expect(found.defaultTarget).toEqual({ kind: "projects", paths: [project] });
  });

  test("a monorepo with solutions in subfolders loads its projects", async () => {
    const { wt } = await makeRoot();
    const solutionA = await write(join(wt, "a", "A.slnx"));
    const solutionB = await write(join(wt, "b", "B.slnx"));
    const projectA = await write(join(wt, "a", "lib", "A.csproj"));
    const projectB = await write(join(wt, "b", "lib", "B.csproj"));
    expect(await discoverCSharpProjects(wt)).toMatchObject({
      solutions: [solutionA, solutionB],
      defaultTarget: { kind: "projects", paths: [projectA, projectB] },
    });
  });

  test("skips ignored trees and files deleted from disk", async () => {
    const { wt } = await makeRoot();
    await write(join(wt, ".gitignore"), "vendor/\nobj/\n");
    await write(join(wt, "vendor", "V.csproj"));
    await write(join(wt, "obj", "Generated.csproj"));
    const kept = await write(join(wt, "Tracked.csproj"));
    const deleted = await write(join(wt, "Deleted.csproj"));
    await commitAll(wt);
    await rm(deleted);
    const untracked = await write(join(wt, "Untracked.csproj"));
    expect((await discoverCSharpProjects(wt)).projects).toEqual([kept, untracked]);
  });

  test("returns nothing for a repository without C#", async () => {
    const { wt } = await makeRoot();
    await write(join(wt, "main.ts"));
    expect(await discoverCSharpProjects(wt)).toEqual({
      solutions: [],
      solutionFilters: [],
      projects: [],
      defaultTarget: null,
    });
  });

  test("lists the root of a directory in no git repository", async () => {
    const { outside } = await makeRoot();
    const project = await write(join(outside, "App.csproj"));
    await write(join(outside, "src", "Other.csproj"));
    expect((await discoverCSharpProjects(outside)).projects).toEqual([project]);
  });

  test("does not throw for a directory that does not exist", async () => {
    const { outside } = await makeRoot();
    const found = await discoverCSharpProjects(join(outside, "gone"));
    expect(found.defaultTarget).toBeNull();
  });
});

describe("csharpRestoreState", () => {
  async function ignoredProject(wt: string, dir = "src/App"): Promise<string> {
    await write(join(wt, ".gitignore"), "obj/\nbin/\nartifacts/\n");
    return write(join(wt, dir, "App.csproj"), '<Project Sdk="Microsoft.NET.Sdk"></Project>');
  }

  test("restored once obj/project.assets.json exists next to the project", async () => {
    const { wt } = await makeRoot();
    const project = await ignoredProject(wt);
    const assetsPath = join(dirname(project), "obj", "project.assets.json");
    expect(await csharpRestoreState(wt, project)).toEqual({ project, restored: false, assetsPath });
    await write(assetsPath, "{}");
    expect(await csharpRestoreState(wt, project)).toEqual({ project, restored: true, assetsPath });
  });

  test("not restored when git tracks the assets file", async () => {
    const { wt } = await makeRoot();
    const project = await write(join(wt, "App.csproj"), "<Project />");
    await write(join(wt, "obj", "project.assets.json"), "{}");
    await commitAll(wt);
    expect((await csharpRestoreState(wt, project)).restored).toBe(false);
  });

  test("follows UseArtifactsOutput next to the props file", async () => {
    const { wt } = await makeRoot();
    const project = await ignoredProject(wt);
    await write(
      join(wt, "Directory.Build.props"),
      "<Project><PropertyGroup><UseArtifactsOutput>true</UseArtifactsOutput></PropertyGroup></Project>",
    );
    const assetsPath = join(wt, "artifacts", "obj", "App", "project.assets.json");
    expect(await csharpRestoreState(wt, project)).toMatchObject({ restored: false, assetsPath });
    await write(assetsPath, "{}");
    expect(await csharpRestoreState(wt, project)).toMatchObject({ restored: true, assetsPath });
  });

  test("the default obj does not count under the artifacts layout", async () => {
    const { wt } = await makeRoot();
    const project = await ignoredProject(wt);
    await write(
      join(wt, "Directory.Build.props"),
      "<Project><PropertyGroup><UseArtifactsOutput>true</UseArtifactsOutput></PropertyGroup></Project>",
    );
    await write(join(dirname(project), "obj", "project.assets.json"), "{}");
    expect((await csharpRestoreState(wt, project)).restored).toBe(false);
  });

  test("follows a literal ArtifactsPath", async () => {
    const { wt } = await makeRoot();
    const project = await ignoredProject(wt);
    await write(
      join(wt, "Directory.Build.props"),
      "<Project><PropertyGroup><ArtifactsPath>$(MSBuildThisFileDirectory)out\\build</ArtifactsPath></PropertyGroup></Project>",
    );
    expect((await csharpRestoreState(wt, project)).assetsPath).toBe(
      join(wt, "out", "build", "obj", "App", "project.assets.json"),
    );
  });

  test("follows static imports, including a file above", async () => {
    const { wt } = await makeRoot();
    const project = await ignoredProject(wt);
    await write(
      join(wt, "src", "Directory.Build.props"),
      `<Project><Import Project="$([MSBuild]::GetPathOfFileAbove('Directory.Build.props', '$(MSBuildThisFileDirectory)../'))" /></Project>`,
    );
    await write(
      join(wt, "Directory.Build.props"),
      '<Project><Import Project="$(MSBuildThisFileDirectory)eng\\Common.props" /></Project>',
    );
    await write(
      join(wt, "eng", "Common.props"),
      "<Project><PropertyGroup><UseArtifactsOutput>true</UseArtifactsOutput></PropertyGroup></Project>",
    );
    expect((await csharpRestoreState(wt, project)).assetsPath).toBe(
      join(wt, "src", "artifacts", "obj", "App", "project.assets.json"),
    );
  });

  test("ignores comments and unrelated conditional groups", async () => {
    const { wt } = await makeRoot();
    const project = await ignoredProject(wt);
    await write(
      join(wt, "Directory.Build.props"),
      `<Project>
        <!-- <PropertyGroup><UseArtifactsOutput>true</UseArtifactsOutput></PropertyGroup> -->
        <PropertyGroup Condition="'$(CI)' == 'true'"><Deterministic>true</Deterministic></PropertyGroup>
        <Import Project="missing.props" Condition="Exists('missing.props')" />
      </Project>`,
    );
    expect((await csharpRestoreState(wt, project)).assetsPath).toBe(
      join(dirname(project), "obj", "project.assets.json"),
    );
  });

  test("reports not restored when the layout cannot be determined from files", async () => {
    const { wt } = await makeRoot();
    const project = await ignoredProject(wt);
    await write(join(dirname(project), "obj", "project.assets.json"), "{}");
    for (const props of [
      "<PropertyGroup Condition=\"'$(CI)'=='1'\"><UseArtifactsOutput>true</UseArtifactsOutput></PropertyGroup>",
      "<PropertyGroup><UseArtifactsOutput Condition=\"'$(CI)'=='1'\">true</UseArtifactsOutput></PropertyGroup>",
      "<PropertyGroup><UseArtifactsOutput>$(Custom)</UseArtifactsOutput></PropertyGroup>",
      "<PropertyGroup><ArtifactsPath>$(RepoRoot)out</ArtifactsPath></PropertyGroup>",
      "<PropertyGroup><BaseIntermediateOutputPath>../o/</BaseIntermediateOutputPath></PropertyGroup>",
      "<PropertyGroup><MSBuildProjectExtensionsPath>../o/</MSBuildProjectExtensionsPath></PropertyGroup>",
      '<Import Project="$(RepoRoot)eng/x.props" />',
      '<Import Project="missing.props" />',
      '<Import Project="Sdk.props" Sdk="Some.Sdk" />',
      '<Sdk Name="Some.Sdk" />',
      "<PropertyGroup><UseArtifactsOutput><![CDATA[true]]></UseArtifactsOutput></PropertyGroup>",
      "<Choose><When Condition=\"'$(CI)'=='1'\"><PropertyGroup><UseArtifactsOutput>true</UseArtifactsOutput></PropertyGroup></When></Choose>",
      '<Target Name="T"><PropertyGroup><UseArtifactsOutput>true</UseArtifactsOutput></PropertyGroup></Target>',
      "<PropertyGroup Label=\">\" Condition=\"'$(CI)'=='1'\"><UseArtifactsOutput>true</UseArtifactsOutput></PropertyGroup>",
      "<PropertyGroup /><PropertyGroup Condition=\"'$(CI)'=='1'\"><UseArtifactsOutput>true</UseArtifactsOutput></PropertyGroup>",
      "<UseArtifactsOutput />",
      "<!<!-- x -->-- <PropertyGroup><UseArtifactsOutput>maybe</UseArtifactsOutput></PropertyGroup>",
      "<Choose><When Condition=\"'$(CI)'=='1'\"><Import Project=\"eng/x.props\" /></When></Choose>",
    ]) {
      await write(join(wt, "Directory.Build.props"), `<Project>${props}</Project>`);
      expect(await csharpRestoreState(wt, project)).toMatchObject({
        restored: false,
        assetsPath: null,
      });
    }
  });

  test("reads large repetitive files in one pass", async () => {
    const { wt } = await makeRoot();
    const project = await ignoredProject(wt);
    const size = 1024 * 1024 - 64;
    let nested = "<!--X-->";
    while (nested.length < size) nested = `<!-${nested}--->`;
    for (const body of [
      nested,
      "<PropertyGroup ".repeat(size / 15),
      "<Choose >".repeat(size / 9),
      "<a<".repeat(size / 3),
      `<PropertyGroup ${"Condition ".repeat(size / 40)}>${"<ArtifactsPath></ArtifactsPath>".repeat(size / 62)}</PropertyGroup>`,
    ]) {
      await write(join(wt, "Directory.Build.props"), `<Project>${body}</Project>`);
      expect((await csharpRestoreState(wt, project)).restored).toBe(false);
    }
  });

  test("reports not restored for a props file that is not a regular file", async () => {
    const { wt } = await makeRoot();
    const project = await ignoredProject(wt);
    await symlink("/dev/zero", join(wt, "Directory.Build.props"));
    expect(await csharpRestoreState(wt, project)).toMatchObject({
      restored: false,
      assetsPath: null,
    });
  });

  test("reports not restored when the project itself moves the output", async () => {
    const { wt } = await makeRoot();
    const project = await write(
      join(wt, "App.csproj"),
      "<Project><PropertyGroup><RestoreOutputPath>o/</RestoreOutputPath></PropertyGroup></Project>",
    );
    await write(join(wt, "obj", "project.assets.json"), "{}");
    expect(await csharpRestoreState(wt, project)).toMatchObject({
      restored: false,
      assetsPath: null,
    });
  });

  test("reports not restored for a project that does not exist", async () => {
    const { wt } = await makeRoot();
    expect((await csharpRestoreState(wt, join(wt, "Gone.csproj"))).restored).toBe(false);
  });
});

describe("subscribeCSharpRestore", () => {
  /** Updates as a queue: `next()` waits for the next one to arrive. */
  function collect(): {
    listener: (update: CSharpRestoreUpdate) => void;
    next: () => Promise<CSharpRestoreUpdate>;
  } {
    const queued: CSharpRestoreUpdate[] = [];
    let waiting: ((update: CSharpRestoreUpdate) => void) | null = null;
    return {
      listener: (update) => {
        if (waiting) {
          waiting(update);
          waiting = null;
        } else queued.push(update);
      },
      next: () => {
        const update = queued.shift();
        if (update) return Promise.resolve(update);
        return new Promise((resolve) => {
          waiting = resolve;
        });
      },
    };
  }

  /**
   * Repeats `act` until `update` arrives, since a new watch can drop its first events. `act` must
   * change something already watched each time, so it recreates the directory.
   */
  async function untilUpdate<T>(update: Promise<T>, act: () => Promise<unknown>): Promise<T> {
    const settled = update.then(() => true);
    for (;;) {
      await act();
      const pause = new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), 2500);
      });
      if (await Promise.race([settled, pause])) return update;
    }
  }

  test("reports a restore appearing and being removed", async () => {
    const { wt } = await makeRoot();
    await write(join(wt, ".gitignore"), "obj/\n");
    const project = await write(join(wt, "App.csproj"), "<Project />");
    const assets = join(wt, "obj", "project.assets.json");
    const { listener, next } = collect();
    const unsubscribe = subscribeCSharpRestore(wt, listener);
    try {
      const first = await next();
      expect(first.first).toBe(true);
      expect(first.states).toEqual([{ project, restored: false, assetsPath: assets }]);

      const restored = await untilUpdate(next(), async () => {
        await rm(join(wt, "obj"), { recursive: true, force: true });
        await write(assets, "{}");
      });
      expect(restored.first).toBe(false);
      expect(restored.states[0]?.restored).toBe(true);

      const removed = await untilUpdate(next(), () =>
        rm(join(wt, "obj"), { recursive: true, force: true }),
      );
      expect(removed.states[0]?.restored).toBe(false);
    } finally {
      unsubscribe();
    }
  });

  test("reports a restore in the artifacts layout", async () => {
    const { wt } = await makeRoot();
    await write(join(wt, ".gitignore"), "artifacts/\n");
    await write(join(wt, "src", "App", "App.csproj"), "<Project />");
    await write(
      join(wt, "Directory.Build.props"),
      "<Project><PropertyGroup><UseArtifactsOutput>true</UseArtifactsOutput></PropertyGroup></Project>",
    );
    const assets = join(wt, "artifacts", "obj", "App", "project.assets.json");
    const { listener, next } = collect();
    const unsubscribe = subscribeCSharpRestore(wt, listener);
    try {
      expect((await next()).states[0]?.restored).toBe(false);
      const restored = await untilUpdate(next(), async () => {
        await rm(join(wt, "artifacts"), { recursive: true, force: true });
        await write(assets, "{}");
      });
      expect(restored.states[0]?.restored).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  test("notices a new props file between the project and the root", async () => {
    const { wt } = await makeRoot();
    await write(join(wt, "src", "App", "App.csproj"), "<Project />");
    const props = join(wt, "src", "Directory.Build.props");
    const { listener, next } = collect();
    const unsubscribe = subscribeCSharpRestore(wt, listener);
    try {
      await next();
      const moved = await untilUpdate(next(), async () => {
        await rm(props, { force: true });
        await write(
          props,
          "<Project><PropertyGroup><UseArtifactsOutput>true</UseArtifactsOutput></PropertyGroup></Project>",
        );
      });
      expect(moved.states[0]?.assetsPath).toBe(
        join(wt, "src", "artifacts", "obj", "App", "project.assets.json"),
      );
    } finally {
      unsubscribe();
    }
  });

  test("a throwing late subscriber neither breaks subscribing nor other listeners", async () => {
    const { wt } = await makeRoot();
    await write(join(wt, "App.csproj"), "<Project />");
    const { listener, next } = collect();
    const unsubscribeFirst = subscribeCSharpRestore(wt, listener);
    await next();
    const late = collect();
    const unsubscribeThrowing = subscribeCSharpRestore(wt, () => {
      throw new Error("listener failed");
    });
    const unsubscribeLate = subscribeCSharpRestore(wt, late.listener);
    try {
      expect((await late.next()).first).toBe(true);
    } finally {
      unsubscribeFirst();
      unsubscribeThrowing();
      unsubscribeLate();
    }
  });

  test("a later subscriber hears the known state, and refresh finds new projects", async () => {
    const { wt } = await makeRoot();
    const project = await write(join(wt, "App.csproj"), "<Project />");
    const firstSubscriber = collect();
    const unsubscribeFirst = subscribeCSharpRestore(wt, firstSubscriber.listener);
    const second = collect();
    let unsubscribeSecond = () => {};
    try {
      await firstSubscriber.next();
      unsubscribeSecond = subscribeCSharpRestore(wt, second.listener);
      expect((await second.next()).states.map((state) => state.project)).toEqual([project]);

      const added = await write(join(wt, "Lib.csproj"), "<Project />");
      refreshCSharpRestore(wt);
      expect((await second.next()).states.map((state) => state.project)).toEqual(
        [added, project].toSorted(),
      );
    } finally {
      unsubscribeFirst();
      unsubscribeSecond();
    }
  });

  test("hears nothing after unsubscribing", async () => {
    const { wt } = await makeRoot();
    await write(join(wt, "App.csproj"), "<Project />");
    const gone = collect();
    const unsubscribeGone = subscribeCSharpRestore(wt, gone.listener);
    await gone.next();
    let heard = false;
    const unsubscribeHeard = subscribeCSharpRestore(wt, () => {
      heard = true;
    });
    unsubscribeHeard();
    heard = false;

    await write(join(wt, "Lib.csproj"), "<Project />");
    refreshCSharpRestore(wt);
    await gone.next();
    expect(heard).toBe(false);
    unsubscribeGone();
  });
});
