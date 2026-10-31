import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readConfigFile } from "./config-file-read";
import { readToml } from "./toml-file";

const root = await mkdtemp(join(tmpdir(), "loxel-config-file-read-"));

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("readConfigFile and readToml", () => {
  test("reads a regular file, also through a symlink", async () => {
    const file = join(root, "plain.toml");
    await writeFile(file, 'name = "x"\n');
    const link = join(root, "link.toml");
    await symlink(file, link);
    expect(readToml(file)).toEqual({ name: "x" });
    expect(readToml(link)).toEqual({ name: "x" });
    expect(readConfigFile(link)).toBe('name = "x"\n');
  });

  test("gives nothing for a missing or unparsable file", async () => {
    const broken = join(root, "broken.toml");
    await writeFile(broken, "= =\n");
    expect(readConfigFile(join(root, "missing.toml"))).toBeUndefined();
    expect(readToml(join(root, "missing.toml"))).toBeUndefined();
    expect(readToml(broken)).toBeUndefined();
  });

  test("gives nothing for a file over the size limit", async () => {
    const large = join(root, "large.toml");
    await writeFile(large, `name = "${"x".repeat(1024 * 1024)}"\n`);
    expect(readConfigFile(large)).toBeUndefined();
  });

  test("does not read what is not a regular file", async () => {
    const dir = join(root, "dir.toml");
    await mkdir(dir);
    const fifo = join(root, "fifo.toml");
    Bun.spawnSync(["mkfifo", fifo]);
    const device = join(root, "device.toml");
    await symlink("/dev/zero", device);
    expect(readConfigFile(dir)).toBeUndefined();
    expect(readConfigFile(fifo)).toBeUndefined();
    expect(readConfigFile(device)).toBeUndefined();
  });
});
