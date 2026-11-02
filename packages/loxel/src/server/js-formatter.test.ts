import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { DEFAULT_FORMATTING_SETTINGS, type FormattingSettings } from "@/lib/formatting-model";

// Trust lives in the store database; keep the tests' state out of the real one.
const stateDir = await mkdtemp(join(tmpdir(), "js-formatter-state-"));
process.env.LOXEL_STATE_DIR = stateDir;
const { FormatService } = await import("./format-service");
const { getRepoTrustStatus, setRepoTrusted } = await import("./repo-trust");

// Saves spawn real processes and resolve Node, which takes a while on a busy machine.
setDefaultTimeout(60_000);

const realNode = Bun.which("node");
const originalPath = process.env.PATH;
const SETTINGS: FormattingSettings = DEFAULT_FORMATTING_SETTINGS;

let root: string;
let wt: string;
let userBin: string;
let service: InstanceType<typeof FormatService>;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "js-formatter-")));
  wt = join(root, "wt");
  userBin = join(root, "user-bin");
  await mkdir(wt, { recursive: true });
  await mkdir(userBin, { recursive: true });
  process.env.PATH = [userBin, realNode && dirname(realNode), "/usr/bin", "/bin"]
    .filter(Boolean)
    .join(":");
  service = new FormatService();
});

afterEach(async () => {
  service.destroy();
  process.env.PATH = originalPath;
  await rm(root, { recursive: true, force: true });
});

afterAll(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

async function write(files: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(wt, name)), { recursive: true });
    await writeFile(join(wt, name), content);
  }
}

/** An executable that reports how it ran and leaves `<label>.ran` beside the worktree. */
async function tool(path: string, label: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const script = `#!/bin/sh\n: > "${root}/${label}.ran"\necho "${label} cwd=$(pwd -P) args=$*"\n`;
  await writeFile(path, script, { mode: 0o755 });
}

const ran = (label: string) => existsSync(join(root, `${label}.ran`));
const inWt = (...parts: string[]) => join(wt, ...parts);
const bin = (dir: string, name: string) => inWt(dir, "node_modules", ".bin", name);
const save = (name: string, settings = SETTINGS) => service.format("x", inWt(name), wt, settings);

/**
 * A prettier package that needs no install: `format` says which copy ran, its options and the
 * process's working directory. `behavior` replaces its body.
 */
async function fakePrettier(dir: string, label: string, behavior = ""): Promise<void> {
  const packageDir = inWt(dir, "node_modules", "prettier");
  await mkdir(packageDir, { recursive: true });
  await writeFile(join(packageDir, "package.json"), '{"name":"prettier","main":"index.js"}');
  await writeFile(
    join(packageDir, "index.js"),
    `require("node:fs").writeFileSync(${JSON.stringify(join(root, `${label}.pid`))}, String(process.pid));
exports.resolveConfig = async (file, options) => ({ fromConfig: JSON.stringify(options) });
exports.format = async (source, options) => {
  ${behavior}
  return ${JSON.stringify(label)} + " cwd=" + process.cwd() + " " + options.fromConfig + " " + options.filepath;
};\n`,
  );
}

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function listed(path = wt) {
  return Object.fromEntries(
    service.getDetectedFormatters(path).map((f) => [f.command, f.extensions]),
  );
}

describe("choosing a formatter in a trusted repository", () => {
  beforeEach(() => setRepoTrusted(wt, true));

  test.each([
    ["biome.json", "{}", "biome"],
    ["biome.jsonc", "// comment\n{}", "biome"],
    [".biome.json", "{}", "biome"],
    [".prettierrc", "{}", "prettier"],
    ["prettier.config.mts", "export default {}", "prettier"],
    ["package.json", '{"prettier":{}}', "prettier"],
    ["package.json", '{"devDependencies":{"prettier":"3.0.0"}}', "prettier"],
    ["package.json", '{"devDependencies":{"@biomejs/biome":"2.0.0"}}', "biome"],
    ["package.json", '{"dependencies":{"oxfmt":"0.71.0"}}', "oxfmt"],
    [".oxfmtrc.jsonc", "{}", "oxfmt"],
  ])("%s holding %s selects %s", async (name, content, command) => {
    await write({ [name]: content });
    expect(Object.keys(listed())).toEqual([command]);
  });

  test.each([
    ["package.json", '{"peerDependencies":{"prettier":"3.0.0"}}'],
    ["biome.json", '{"formatter":{"enabled":false}}'],
    ["biome.jsonc", '{ "formatter": { "enabled": false } /* lint only */ }'],
    ["package.json", "not json"],
  ])("%s holding %s selects nothing", async (name, content) => {
    await write({ [name]: content });
    expect(listed()).toEqual({});
  });

  test("a linter-only Biome config rules out its dependency, for a prettier beside it", async () => {
    await write({
      "biome.json": '{"formatter":{"enabled":false}}',
      "package.json": '{"devDependencies":{"@biomejs/biome":"2.0.0","prettier":"3.0.0"}}',
    });
    expect(Object.keys(listed())).toEqual(["prettier"]);
    await tool(join(userBin, "prettier"), "user-prettier");
    expect((await save("a.ts")).content).toStartWith("user-prettier ");
  });

  test("a directory named like a config is not one", async () => {
    await mkdir(inWt(".prettierrc"));
    await mkdir(inWt("biome.json"));
    expect(listed()).toEqual({});
  });

  test("a config beats a dependency, and within each Biome then prettier then oxfmt", async () => {
    await tool(bin(".", "biome"), "biome");
    await tool(bin(".", "oxfmt"), "oxfmt");
    await write({
      ".oxfmtrc.json": "{}",
      "package.json": '{"devDependencies":{"@biomejs/biome":"2.0.0"}}',
    });
    await tool(bin(".", "prettier"), "prettier");
    // The fake answers no LSP, so the fallback command reports, after the backend's timeout.
    expect((await save("a.toml")).content).toStartWith("oxfmt ");
    expect((await save("a.js")).content).toStartWith("oxfmt ");
    await write({ ".prettierrc": "{}" });
    expect((await save("a.js")).content).toStartWith("prettier ");
    await write({ "biome.json": "{}" });
    expect((await save("a.js")).content).toStartWith("biome ");
    // Biome has no markdown: the prettier beside it takes that.
    expect((await save("a.md")).content).toStartWith("prettier ");
  });

  test("the nearest signal wins, and a tool without the extension passes it upward", async () => {
    await write({
      ".prettierrc": "{}",
      "apps/bio/biome.json": "{}",
      "apps/bio/src/.keep": "",
      "apps/plain/src/.keep": "",
    });
    await tool(bin(".", "prettier"), "root-prettier");
    await tool(bin("apps/bio", "biome"), "bio-biome");
    expect((await save("apps/bio/src/a.ts")).content).toStartWith("bio-biome ");
    expect((await save("apps/bio/src/a.md")).content).toStartWith("root-prettier ");
    expect((await save("apps/plain/src/a.ts")).content).toStartWith("root-prettier ");
  });

  test("a subproject's own node_modules/.bin wins over the root's", async () => {
    await write({ "biome.json": "{}", "apps/a/src/.keep": "" });
    await tool(bin(".", "biome"), "root-biome");
    expect((await save("apps/a/src/a.ts")).content).toStartWith("root-biome ");
    await tool(bin("apps/a", "biome"), "sub-biome");
    expect((await save("apps/a/src/a.ts")).content).toStartWith("sub-biome ");
  });

  test("Biome runs from the file's directory, as it reads its config from the cwd", async () => {
    await write({ "biome.json": "{}", "src/.keep": "" });
    await tool(bin(".", "biome"), "biome");
    expect((await save("src/a.ts")).content).toBe(
      `biome cwd=${inWt("src")} args=format --stdin-file-path=${inWt("src/a.ts")}\n`,
    );
  });

  test("Biome's own binary runs, so no Node starts inside the project", async () => {
    await write({ "biome.json": "{}" });
    await tool(bin(".", "biome"), "biome-wrapper");
    const arch = `cli-${process.platform}-${process.arch}`;
    await tool(inWt("node_modules/@biomejs", arch, "biome"), "biome-native");
    await mkdir(inWt("node_modules/@biomejs/biome"));
    expect((await save("a.ts")).content).toStartWith("biome-native ");
  });

  test("Settings lists each tool the root signals, with its own extensions", async () => {
    await write({ ".prettierrc": "{}", ".oxfmtrc.json": "{}", "biome.json": "{}" });
    const formatters = listed();
    expect(Object.keys(formatters)).toEqual(["biome", "prettier", "oxfmt"]);
    expect(formatters.biome).toContain("gql");
    expect(formatters.biome).not.toContain("md");
    expect(formatters.prettier).toContain("astro");
    expect(formatters.prettier).not.toContain("toml");
    expect(formatters.oxfmt).toContain("toml");
    expect(formatters.oxfmt).not.toContain("svelte");
  });

  test("a missing tool says what to do", async () => {
    await write({ "biome.json": "{}" });
    expect((await save("a.ts")).notice).toBe(
      "Format on save skipped: this project uses Biome, which is not installed. Install the project's dependencies in a terminal.",
    );
  });

  test("deno is left to the worktree-root rule, including mjs and cjs", async () => {
    await write({ "deno.json": "{}" });
    await tool(join(userBin, "deno"), "deno");
    expect(listed().deno).toContain("mjs");
    expect((await save("a.cjs")).content).toBe(`deno cwd=${wt} args=fmt --ext cjs -\n`);
  });
});

describe("the prettier process", () => {
  beforeEach(() => setRepoTrusted(wt, true));

  test.skipIf(!realNode)("runs the project's prettier from the project", async () => {
    await write({ ".prettierrc": "{}", "src/.keep": "" });
    await fakePrettier(".", "root-prettier");
    const { content } = await save("src/a.ts");
    expect(content).toBe(
      `root-prettier cwd=${wt} {"editorconfig":true,"useCache":false} ${inWt("src/a.ts")}`,
    );
  });

  test.skipIf(!realNode)("each matched directory gets its own, with its own prettier", async () => {
    await write({ ".prettierrc": "{}", "apps/a/.prettierrc": "{}", "apps/b/.prettierrc": "{}" });
    await fakePrettier(".", "root-prettier");
    await fakePrettier("apps/a", "a-prettier");
    expect((await save("apps/a/x.ts")).content).toStartWith(`a-prettier cwd=${inWt("apps/a")} `);
    expect((await save("apps/b/x.ts")).content).toStartWith(`root-prettier cwd=${inWt("apps/b")} `);
    expect((await save("x.ts")).content).toStartWith(`root-prettier cwd=${wt} `);
  });

  test.skipIf(!realNode)("a syntax error keeps it running, with no command fallback", async () => {
    await write({ ".prettierrc": "{}" });
    await fakePrettier(".", "prettier", 'if (source === "bad") throw new Error("syntax");');
    await tool(bin(".", "prettier"), "cli");
    expect((await service.format("bad", inWt("a.ts"), wt, SETTINGS)).content).toBeNull();
    expect(ran("cli")).toBe(false);
    const pid = Number(await readFile(join(root, "prettier.pid"), "utf-8"));
    expect((await save("a.ts")).content).toStartWith("prettier ");
    expect(Number(await readFile(join(root, "prettier.pid"), "utf-8"))).toBe(pid);
  });

  test("with no project prettier, the command runs instead", async () => {
    await write({ ".prettierrc": "{}" });
    await tool(join(userBin, "prettier"), "global");
    expect((await save("a.ts")).content).toBe(
      `global cwd=${wt} args=--stdin-filepath ${inWt("a.ts")}\n`,
    );
  });
});

describe("an untrusted repository", () => {
  const CANARIES = ["prettier", "oxfmt", "biome"];
  const heldBack = (label: string) =>
    `Format on save skipped: ${label} would run code from this repository, which you haven't trusted. Use Restricted in the status bar to choose.`;

  async function plantCanaries(): Promise<void> {
    for (const name of CANARIES) await tool(bin(".", name), `project-${name}`);
    await fakePrettier(".", "project-prettier-lib");
  }

  function expectNoProjectCode(): void {
    for (const name of CANARIES) expect(ran(`project-${name}`)).toBe(false);
    expect(existsSync(join(root, "project-prettier-lib.pid"))).toBe(false);
  }

  test.each([
    [".prettierrc", "Prettier"],
    [".oxfmtrc.json", "oxfmt"],
    ["biome.json", "Biome"],
  ])("%s runs nothing from the project and reports what is held back", async (config, label) => {
    await write({ [config]: "{}" });
    await plantCanaries();
    expect(await save("a.ts")).toEqual({ content: null, notice: heldBack(label) });
    expectNoProjectCode();
    expect(getRepoTrustStatus(wt).restrictions).toEqual([`${label} doesn't format on save.`]);
  });

  test("a user's own prettier does not load the project's config either", async () => {
    await write({ ".prettierrc.js": "" });
    await tool(join(userBin, "prettier"), "user-prettier");
    expect(await save("a.ts")).toEqual({ content: null, notice: heldBack("Prettier") });
    expect(ran("user-prettier")).toBe(false);
    expect(getRepoTrustStatus(wt).restrictions).toHaveLength(1);
  });

  test("a user's own Biome runs, as its config is only data, and nothing is held back", async () => {
    await write({ "biome.json": "{}" });
    await plantCanaries();
    await tool(join(userBin, "biome"), "user-biome");
    expect((await save("a.ts")).content).toStartWith("user-biome ");
    expectNoProjectCode();
    expect(getRepoTrustStatus(wt).restrictions).toEqual([]);
  });

  test("a link on PATH leading into the worktree is not the user's own", async () => {
    await write({ "biome.json": "{}" });
    await tool(bin(".", "biome"), "project-biome");
    await symlink(bin(".", "biome"), join(userBin, "biome"));
    expect((await save("a.ts")).notice).toBe(heldBack("Biome"));
    expect(ran("project-biome")).toBe(false);
  });

  test("nothing installed anywhere is not held back: trust would not help", async () => {
    await write({ ".prettierrc": "{}" });
    expect((await save("a.ts")).notice).toBe(
      "Format on save skipped: this project uses Prettier, which is not installed. Install the project's dependencies in a terminal.",
    );
    expect(getRepoTrustStatus(wt).restrictions).toEqual([]);
  });

  test("listing in Settings runs nothing and does not make the UI ask", async () => {
    await write({ ".prettierrc": "{}" });
    await plantCanaries();
    expect(listed()).toEqual({});
    expectNoProjectCode();
    expect(getRepoTrustStatus(wt).restrictions).toEqual([]);
  });

  const withOverride = (command: string): FormattingSettings => ({
    ...SETTINGS,
    overrides: [{ id: "o", extensions: "ts", command, args: "--stdin {file}" }],
  });

  test("an override is the user's own setting and runs, from the worktree", async () => {
    await write({ "src/.keep": "" });
    await tool(join(userBin, "other-fmt"), "user-other");
    expect((await save("src/a.ts", withOverride("other-fmt"))).content).toStartWith(
      `user-other cwd=${wt} `,
    );
    expect(getRepoTrustStatus(wt).restrictions).toEqual([]);
  });

  test("an override of prettier runs the user's, not the worktree's", async () => {
    await tool(bin(".", "prettier"), "project-prettier");
    await tool(join(userBin, "prettier"), "user-prettier");
    expect((await save("a.ts", withOverride("prettier"))).content).toStartWith("user-prettier ");
    expect(ran("project-prettier")).toBe(false);
  });

  test("another override by name never finds the worktree's node_modules/.bin", async () => {
    await tool(bin(".", "other-fmt"), "project-other");
    await tool(join(userBin, "other-fmt"), "user-other");
    expect((await save("a.ts", withOverride("other-fmt"))).content).toStartWith("user-other ");
    expect(ran("project-other")).toBe(false);
  });

  test("deno comes from the user's PATH, and a worktree one does not run", async () => {
    await write({ "deno.json": "{}" });
    await tool(bin(".", "deno"), "project-deno");
    await tool(join(userBin, "deno"), "user-deno");
    expect((await save("a.ts")).content).toStartWith("user-deno ");
    expect(ran("project-deno")).toBe(false);
  });

  test("trusting it later runs the project's tools on the next save", async () => {
    await write({ "biome.json": "{}" });
    await tool(bin(".", "biome"), "project-biome");
    expect((await save("a.ts")).notice).toBe(heldBack("Biome"));
    setRepoTrusted(wt, true);
    expect((await save("a.ts")).content).toStartWith("project-biome ");
  });
});

describe("version manager shims", () => {
  async function shim(name: string, label: string): Promise<string> {
    const shimsDir = join(root, "shims");
    await tool(join(shimsDir, name), label);
    process.env.PATH = `${shimsDir}:${process.env.PATH}`;
    return shimsDir;
  }

  test.each(["biome", "deno"])(
    "%s through a shim does not start inside the project",
    async (name) => {
      setRepoTrusted(wt, true);
      await write({ [`${name}.json`]: "{}" });
      await shim(name, "shim");
      const { content, notice } = await save("a.ts");
      expect(content).toBeNull();
      expect(notice).toContain("version manager's shim");
      expect(ran("shim")).toBe(false);
    },
  );

  test("a shim that can run from elsewhere runs from the filesystem root", async () => {
    setRepoTrusted(wt, true);
    await write({ ".prettierrc": "{}" });
    await shim("prettier", "shim");
    expect((await save("a.ts")).content).toBe(`shim cwd=/ args=--stdin-filepath ${inWt("a.ts")}\n`);
  });

  test("an untrusted repository's override through a shim runs from the root too", async () => {
    await shim("other-fmt", "shim");
    const settings = {
      ...SETTINGS,
      overrides: [{ id: "o", extensions: "ts", command: "other-fmt", args: "{file}" }],
    };
    expect((await save("a.ts", settings)).content).toBe(`shim cwd=/ args=${inWt("a.ts")}\n`);
  });

  test("a script whose interpreter is a shim runs from the root", async () => {
    setRepoTrusted(wt, true);
    const shimsDir = await shim("python3", "shim");
    await mkdir(dirname(join(userBin, "other-fmt")), { recursive: true });
    await writeFile(join(userBin, "other-fmt"), "#!/usr/bin/env python3\n", { mode: 0o755 });
    // Only the shim's existence matters here: `sh` stands in, so the check is on the first line.
    await writeFile(join(shimsDir, "python3"), `#!/bin/sh\necho "py cwd=$(pwd -P)"\n`, {
      mode: 0o755,
    });
    const settings = {
      ...SETTINGS,
      overrides: [{ id: "o", extensions: "ts", command: "other-fmt", args: "" }],
    };
    expect((await save("a.ts", settings)).content).toBe("py cwd=/\n");
  });

  test("a project script under a shim's node runs from the root", async () => {
    setRepoTrusted(wt, true);
    await write({ ".prettierrc": "{}" });
    await tool(bin(".", "prettier"), "project-script");
    const shimsDir = await shim("node", "node-shim");
    process.env.PATH = `${shimsDir}:/usr/bin:/bin`;
    expect((await save("a.ts")).content).toBe(
      `project-script cwd=/ args=--stdin-filepath ${inWt("a.ts")}\n`,
    );
  });
});

describe("trust revoked while a formatter runs", () => {
  beforeEach(() => setRepoTrusted(wt, true));

  /** Trust stops only after `label` shows it has started, so nothing here depends on timing. */
  async function untilExists(path: string): Promise<void> {
    while (!existsSync(path)) await Bun.sleep(5);
  }

  test.skipIf(!realNode)("the prettier process stops, and the save holds back", async () => {
    await write({ ".prettierrc": "{}" });
    const started = join(root, "started");
    await fakePrettier(
      ".",
      "prettier",
      `require("node:fs").writeFileSync(${JSON.stringify(started)}, ""); await new Promise(() => {});`,
    );
    await tool(join(userBin, "prettier"), "user-prettier");
    const saving = save("a.ts");
    await untilExists(started);
    const pid = Number(await readFile(join(root, "prettier.pid"), "utf-8"));
    expect(isRunning(pid)).toBe(true);

    setRepoTrusted(wt, false);

    expect(await saving).toEqual({ content: null });
    expect(ran("user-prettier")).toBe(false);
    while (isRunning(pid)) await Bun.sleep(5);
    expect((await save("b.ts")).content).toBeNull();
  });

  test("a formatter in flight stops, with what it started", async () => {
    await write({ "biome.json": "{}" });
    const started = join(root, "started");
    await mkdir(dirname(bin(".", "biome")), { recursive: true });
    await writeFile(
      bin(".", "biome"),
      `#!/bin/sh\nsleep 60 &\necho $! > "${started}.tmp"\nmv "${started}.tmp" "${started}"\nwait\n`,
      { mode: 0o755 },
    );
    const saving = save("a.ts");
    await untilExists(started);
    const child = Number(await readFile(started, "utf-8"));
    expect(isRunning(child)).toBe(true);

    setRepoTrusted(wt, false);

    // A timeout would carry a notice, and a surviving child would hold this save open.
    expect(await saving).toEqual({ content: null });
    while (isRunning(child)) await Bun.sleep(5);
  });

  test("another repository's change leaves this one's formatter running", async () => {
    await write({ "biome.json": "{}" });
    const started = join(root, "started");
    const release = join(root, "release");
    await mkdir(dirname(bin(".", "biome")), { recursive: true });
    await writeFile(
      bin(".", "biome"),
      `#!/bin/sh\n: > "${started}"\nwhile [ ! -e "${release}" ]; do sleep 0.01; done\necho finished\n`,
      { mode: 0o755 },
    );
    const other = join(root, "other");
    await mkdir(other);
    setRepoTrusted(other, true);
    const saving = save("a.ts");
    await untilExists(started);

    setRepoTrusted(other, false);
    await writeFile(release, "");

    expect((await saving).content).toBe("finished\n");
  });

  test("trust ending while a save prepares its formatter keeps it from starting", async () => {
    await write({ "biome.json": "{}" });
    await tool(bin(".", "biome"), "project-biome");
    const started = join(root, "started");
    const release = join(root, "release");
    // Resolving the worktree's Node asks this for its version.
    await writeFile(
      join(userBin, "node"),
      `#!/bin/sh\n: > "${started}"\nwhile [ ! -e "${release}" ]; do sleep 0.01; done\necho v24.0.0\n`,
      { mode: 0o755 },
    );
    const saving = save("a.ts");
    await untilExists(started);

    setRepoTrusted(wt, false);
    await writeFile(release, "");

    expect((await saving).content).toBeNull();
    expect(ran("project-biome")).toBe(false);
  });
});

describe("the oxfmt process", () => {
  const pidsFile = () => join(root, "lsp-pids");

  /** Answers like `oxfmt --lsp`, and records each start. */
  async function fakeOxfmtLsp(): Promise<void> {
    process.env.PATH = `${dirname(process.execPath)}:${process.env.PATH}`;
    await mkdir(dirname(bin(".", "oxfmt")), { recursive: true });
    await writeFile(
      bin(".", "oxfmt"),
      `#!/usr/bin/env bun
require("node:fs").appendFileSync(${JSON.stringify(pidsFile())}, process.pid + "\\n");
let buf = Buffer.alloc(0);
const reply = (id, result) => {
  const body = JSON.stringify({ jsonrpc: "2.0", id, result });
  process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body);
};
for await (const chunk of Bun.stdin.stream()) {
  buf = Buffer.concat([buf, Buffer.from(chunk)]);
  for (;;) {
    const end = buf.indexOf("\\r\\n\\r\\n");
    if (end < 0) break;
    const len = Number(/Content-Length: (\\d+)/.exec(buf.subarray(0, end).toString())[1]);
    if (buf.length < end + 4 + len) break;
    const msg = JSON.parse(buf.subarray(end + 4, end + 4 + len).toString());
    buf = buf.subarray(end + 4 + len);
    if (msg.method === "initialize") reply(msg.id, { capabilities: { documentFormattingProvider: true } });
    if (msg.method === "textDocument/formatting") {
      const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
      reply(msg.id, [{ range, newText: "lsp" }]);
    }
  }
}
`,
      { mode: 0o755 },
    );
  }

  const lspPids = async () => (await readFile(pidsFile(), "utf-8")).trim().split("\n").map(Number);

  beforeEach(() => setRepoTrusted(wt, true));

  test("concurrent saves share one process, which stops with the service", async () => {
    await write({ ".oxfmtrc.json": "{}" });
    await fakeOxfmtLsp();
    const results = await Promise.all([save("a.ts"), save("b.ts"), save("c.ts")]);
    expect(results.map((r) => r.content)).toEqual(["lsp", "lsp", "lsp"]);
    const pids = await lspPids();
    expect(pids).toHaveLength(1);
    service.destroy();
    while (isRunning(pids[0]!)) await Bun.sleep(5);
  });

  test("it stops when trust ends", async () => {
    await write({ ".oxfmtrc.json": "{}" });
    await fakeOxfmtLsp();
    expect((await save("a.ts")).content).toBe("lsp");
    const [pid] = await lspPids();
    setRepoTrusted(wt, false);
    while (isRunning(pid!)) await Bun.sleep(5);
    expect((await save("a.ts")).content).toBeNull();
  });
});
