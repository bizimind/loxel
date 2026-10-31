import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Each test spawns tools; on a loaded machine that takes far longer than the default.
setDefaultTimeout(120_000);

const stateDir = await mkdtemp(join(tmpdir(), "rust-tool-shim-state-"));
process.env.LOXEL_STATE_DIR = stateDir;
const { resolveRustToolchain } = await import("./rust-toolchain");
const { isVersionManagerShim } = await import("./rust-tool-shim");

let root: string;

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function makeBin(): Promise<{
  wt: string;
  bin: string;
  canary: string;
  env: Record<string, string>;
}> {
  root = await realpath(await mkdtemp(join(tmpdir(), "rust-tool-shim-")));
  const wt = join(root, "wt");
  const bin = join(root, "bin");
  await Promise.all([mkdir(wt), mkdir(bin)]);
  return {
    wt,
    bin,
    canary: join(root, "RAN"),
    env: { PATH: bin, HOME: join(root, "home"), RUSTUP_HOME: join(root, "rustup") },
  };
}

async function writeScript(filePath: string, canary: string): Promise<string> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `#!/bin/sh\ntouch "${canary}"\necho "rustc 9.9.9"\n`);
  await chmod(filePath, 0o755);
  return filePath;
}

describe("isVersionManagerShim", () => {
  test("a script is one, a binary is not", async () => {
    const { bin, canary } = await makeBin();
    expect(await isVersionManagerShim(await writeScript(join(bin, "cargo"), canary))).toBe(true);
    const binary = join(bin, "rustc");
    await copyFile("/bin/echo", binary);
    expect(await isVersionManagerShim(binary)).toBe(false);
  });

  test("a link to mise or rtx is one, and a link to rustup is not", async () => {
    const { bin } = await makeBin();
    for (const manager of ["mise", "rtx"]) {
      const target = join(root, manager, manager);
      await mkdir(dirname(target));
      await copyFile("/bin/echo", target);
      await symlink(target, join(bin, `cargo-${manager}`));
      expect(await isVersionManagerShim(join(bin, `cargo-${manager}`))).toBe(true);
    }
    await copyFile("/bin/echo", join(bin, "rustup"));
    await symlink("rustup", join(bin, "rustc"));
    expect(await isVersionManagerShim(join(bin, "rustc"))).toBe(false);
  });

  test("what cannot be read counts", async () => {
    const { bin } = await makeBin();
    expect(await isVersionManagerShim(join(bin, "missing"))).toBe(true);
  });
});

describe("resolving past a shim", () => {
  test("script shims start nothing, and the status says why", async () => {
    const { wt, bin, canary, env } = await makeBin();
    for (const tool of ["rustup", "rustc", "cargo", "rustfmt", "rust-analyzer"]) {
      await writeScript(join(bin, tool), canary);
    }

    const toolchain = await resolveRustToolchain(wt, { chosen: null, env });

    expect(toolchain).toMatchObject({ status: "none", rustupPath: null });
    expect(toolchain).toHaveProperty("detail", expect.stringContaining("version-manager shims"));
    expect(await Bun.file(canary).exists()).toBe(false);
  });

  test("a link to mise starts nothing", async () => {
    const { wt, bin, canary, env } = await makeBin();
    const mise = await writeScript(join(root, "mise-install", "mise"), canary);
    await symlink(mise, join(bin, "rustc"));
    await symlink(mise, join(bin, "rustup"));

    expect(await resolveRustToolchain(wt, { chosen: null, env })).toMatchObject({ status: "none" });
    expect(await Bun.file(canary).exists()).toBe(false);
  });

  test("a rejected rustup leaves a real rustc, and a rejected tool is null", async () => {
    const { wt, bin, canary, env } = await makeBin();
    await writeScript(join(bin, "rustup"), canary);
    await writeScript(join(bin, "cargo"), canary);
    const rustc = join(bin, "rustc");
    await copyFile("/bin/echo", rustc);
    const rustfmt = join(bin, "rustfmt");
    await copyFile("/bin/echo", rustfmt);

    expect(await resolveRustToolchain(wt, { chosen: null, env })).toMatchObject({
      status: "active",
      source: "no-rustup",
      rustcPath: rustc,
      tools: { cargo: null, rustfmt },
    });
    expect(await Bun.file(canary).exists()).toBe(false);
  });

  test("the next entry on PATH is used after a shim", async () => {
    const { wt, bin, canary, env } = await makeBin();
    const shims = join(root, "shims");
    await writeScript(join(shims, "rustc"), canary);
    const rustc = join(bin, "rustc");
    await copyFile("/bin/echo", rustc);

    expect(
      await resolveRustToolchain(wt, { chosen: null, env: { ...env, PATH: `${shims}:${bin}` } }),
    ).toMatchObject({ source: "no-rustup", rustcPath: rustc });
    expect(await Bun.file(canary).exists()).toBe(false);
  });
});
